// server.js
// where your node app starts

// init project
const zulip = require("zulip-js");
var express = require("express");
var bodyParser = require("body-parser");
var fs = require("fs");
var shuffle = require("lodash/shuffle");

// we've started you off with Express,
// but feel free to use whatever libs or frameworks you'd like through `package.json`.

// http://expressjs.com/en/starter/static-files.html
var app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// init sqlite db
var dbFile = "./.data/sqlite.db";
var exists = fs.existsSync(dbFile);
var sqlite3 = require("sqlite3").verbose();
var db = new sqlite3.Database(dbFile);

const createUsersMigration = () => {
  db.serialize(function() {
    db.run(
      "CREATE TABLE IF NOT EXISTS users (email STRING NOT NULL UNIQUE, coffee_days STRING NOT NULL);"
    );
    db.serialize(function() {
      db.run("CREATE INDEX IF NOT EXISTS users_email_index ON users (email);");
    });
  });
};

// if ./.data/sqlite.db does not exist, create it, otherwise print records to console
db.serialize(function() {
  if (!exists) {
    db.run(`CREATE TABLE matches ( 
              date TEXT NOT NULL,  
              email1 TEXT NOT NULL, 
              email2 TEXT NOT NULL
            );`);
    db.serialize(function() {
      db.run("CREATE INDEX date_index ON matches (date)");
      db.run("CREATE INDEX email1_index ON matches (email1)");
      db.run("CREATE INDEX email2_index ON matches (email2)");
      db.run("CREATE INDEX email1_email2_index ON matches (email1, email2)");
      console.log('New table "matches" created!');
    });
  } else {
    createUsersMigration();
    console.log('Database "matches" ready to go!');
  }
});

const getTodaysEmails = async ({ emails }) => {
  const userConfigs = await new Promise((resolve, reject) => {
    db.all(
      `SELECT email, coffee_days
            FROM users 
            WHERE email in ("${emails.join('","')}")`,
      [],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
  
  const userConfigMap = userConfigs.reduce((acc, v) => {
    acc[v["email"]] = String(v["coffee_days"]);
    return acc;
  }, {});
  const today = (new Date).getDay();
  const isDefaultDay = process.env.DEFAULT_COFFEE_DAYS.includes(today)
  return emails.filter(email => {
    const config = userConfigMap[email];
    if (!config && isDefaultDay) return true;
    if (config && config.includes(today)) return true;
    return false;
  })
}

// set up Zulip JS library
const zulipConfig = {
  username: process.env.ZULIP_USERNAME,
  apiKey: process.env.ZULIP_API_KEY,
  realm: process.env.ZULIP_REALM
};

const oddNumberBackupEmails = ["alicia@recurse.com"];

const getSubscribedEmails = async ({ zulipAPI, users }) => {
  const botSubsResponse = await zulipAPI.streams.subscriptions.retrieve();
  const botSubs = botSubsResponse.subscriptions;
  const allSubscribedEmails = botSubs.filter(sub => sub.stream_id === 142655)[0]
    .subscribers;
  return allSubscribedEmails.filter(email => {
    return (
      email !== zulipConfig.username &&
      !getUserWithEmail({ users, email }).is_bot
    );
  });
};



const getUserWithEmail = ({ users, email }) => {
  return users.find(user => user.email === email);
};

const tryToGetUsernameWithEmail = ({ users, email }) => {
  try {
    return getUserWithEmail({ users, email }).full_name;
  } catch (e) {
    return email;
  }
};

const matchEmails = async ({ emails }) => {
  const pastMatches = await new Promise((resolve, reject) => {
    db.all(
      `SELECT * 
            FROM matches 
            WHERE email1 in ("${emails.join('","')}")
            OR email2 in ("${emails.join('","')}")`,
      [],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
  let unmatchedEmails = shuffle(emails);
  const newMatches = [];
  while (unmatchedEmails.length > 0) {
    const currentEmail = unmatchedEmails.shift();
    const matchedEmails = pastMatches
      .filter(
        match => match.email1 === currentEmail || match.email2 === currentEmail
      ) // filter to current email's matches
      .sort((a, b) => Number(new Date(a.date)) - Number(new Date(b.date))) // sort oldest to newest, so if there is a conflict we can rematch with oldest first
      .map(
        match => (match.email1 === currentEmail ? match.email2 : match.email1)
      ) // map matches to just other people's emails
      .filter((value, index, self) => self.indexOf(value) === index); // uniq emails // TODO: this should be a reduce that adds a match count to every email so we can factor that into matches
    const availableEmails = unmatchedEmails.filter(
      email => !matchedEmails.includes(email)
    );
    //
    if (availableEmails.length > 0) {
      // TODO: potentialy prioritize matching people from different batches
      newMatches.push([currentEmail, availableEmails[0]]);
      unmatchedEmails.splice(unmatchedEmails.indexOf(availableEmails[0]), 1);
    } else if (matchedEmails.length > 0 && unmatchedEmails.length > 0) {
      newMatches.push([currentEmail, matchedEmails[0]]);
      unmatchedEmails.splice(unmatchedEmails.indexOf(matchedEmails[0]), 1);
    } else {
      // this should only happen on an odd number of emails
      // TODO: how to handle the odd person
      newMatches.push([
        currentEmail,
        oddNumberBackupEmails[
          Math.floor(Math.random() * oddNumberBackupEmails.length)
        ]
      ]);
    }
    // console.log("<<<<<<", newMatches);
  }
  return newMatches;
};

const sendMessage = ({ zulipAPI, toEmail, matchedName }) => {
  zulipAPI.messages.send({
    to: toEmail,
    type: "private",
    content: `Hi there! You're having coffee (or tea, or a walk, or whatever you fancy) with @**${matchedName}** today - enjoy! See [${
      matchedName.split(" ")[0]
    }'s profile](https://www.recurse.com/directory?q=${encodeURIComponent(
      matchedName
    )}) for more details.`
  });
};

const sendAllMessages = ({ zulipAPI, matchedEmails, users }) => {
  console.log("-----------");
  console.log(matchedEmails);
  db.serialize(function() {
    matchedEmails.forEach(match => {
      const sortedMatch = match.sort();
      db.run(
        `INSERT INTO matches(date, email1, email2) VALUES ("${
          new Date().toISOString().split("T")[0]
        }", "${sortedMatch[0]}", "${sortedMatch[1]}")`
      );
      sendMessage({
        zulipAPI,
        toEmail: match[0],
        matchedName: tryToGetUsernameWithEmail({ users, email: match[1] })
      });
      sendMessage({
        zulipAPI,
        toEmail: match[1],
        matchedName: tryToGetUsernameWithEmail({ users, email: match[0] })
      });
    });
  });
};

const run = async () => {
  const zulipAPI = await zulip(zulipConfig);
  const users = (await zulipAPI.users.retrieve()).members;

  const activeEmails = await getSubscribedEmails({ zulipAPI, users });
  const todaysActiveEmails = await getTodaysEmails({ emails: activeEmails });

  const matchedEmails = await matchEmails({ emails: todaysActiveEmails });
  sendAllMessages({ zulipAPI, matchedEmails, users });
};

// http://expressjs.com/en/starter/basic-routing.html
app.get("/", function(request, response) {
  response.sendFile(__dirname + "/views/index.html"); // TODO: update this page
});

app.post("/cron/run", function(request, response) {
  console.log("Running the matcher and sending out matches");
  if (request.headers.secret === process.env.RUN_BODY) run();
  response.status(200).json({ status: "ok" });
});

// listen for requests :)
const listener = app.listen(process.env.PORT, function() {
  console.log("Your app is listening on port " + listener.address().port);
});

// // util for testing messages
// const test = async () => {
//   // const zulipAPI = await zulip(zulipConfig);
//   // sendMessage({ zulipAPI, toEmail: "<>", matchedName: "<>" });
//   db.run('INSERT OR REPLACE INTO users(email, coffee_days) VALUES ("c", "3")');
//   console.log(await getTodaysEmails({emails: ["c", "d"]}), (new Date("2018-10-07")).getDay());
// };
// test()

