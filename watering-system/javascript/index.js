"use strict";

// The program is using the Node.js built-in `fs` module
// to load the config.json and any other files needed
var fs = require("fs");

// The program is using the Node.js built-in `path` module to find
// the file path to needed files on disk
var path = require("path");

// Load configuration data from `config.json` file. Edit this file
// to change to correct values for your configuration
var config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config.json"))
);

// The program is using the `superagent` module
// to make the remote calls to the data store
var request = require("superagent");

// The program is using the `later` module
// to handle scheduling of recurring tasks
var later = require("later");

// The program is using the `mraa` module
// to communicate directly with the digital
// pin used to turn on/off the water pump
var mraa = require("mraa");

// The program is using the `twilio` module
// to make the remote calls to Twilio service
// to send SMS alerts
var twilio = require("twilio")(config.TWILIO_ACCT_SID,
                               config.TWILIO_AUTH_TOKEN);

// Used to store the schedule for turning on/off the
// watering system, as well as store moisture data
var SCHEDULE = {},
    MOISTURE = [],
    intervals = [];

// Initialize the hardware devices
var moisture = new (require("jsupm_grovemoisture").GroveMoisture)(0),
    flow = new (require("jsupm_grovewfs").GroveWFS)(2),
    pump = new mraa.Gpio(4);

// Set GPIO direction to output
pump.dir(mraa.DIR_OUT);

// Set up 0-23 hour schedules
for (var i = 0; i < 24; i++) {
  SCHEDULE[i] = { on: false, off: false };
}

// Helper function to convert a value to an integer
function toInt(h) { return +h; }

// Display and then store record in the remote datastore
// of each time a watering system event has occurred
function log(event) {
  console.log(event);
  if (!config.SERVER || !config.AUTH_TOKEN) {
    return;
  }

  function callback(err, res) {
    if (err) { return console.error("err:", res.text); }
    console.log("Server notified");
  }

  request
    .put(config.SERVER)
    .set("X-Auth-Token", config.AUTH_TOKEN)
    .send({ value: event + " " + new Date().toISOString() })
    .end(callback);
}

// Generates a later schedule for when the water should be turned on
function onSchedule() {
  function isOn(h) { return SCHEDULE[h].on; }

  return {
    schedules: [ { h: Object.keys(SCHEDULE).filter(isOn).map(toInt) } ]
  };
}

// Generates a later schedule for when the water should be turned off
function offSchedule() {
  function isOff(h) { return SCHEDULE[h].off; }

  return {
    schedules: [ { h: Object.keys(SCHEDULE).filter(isOff).map(toInt) } ]
  };
}

// Send a SMS alert indicating something's wrong
function alert() {
  console.log("Watering system alert");
  if (!config.TWILIO_ACCT_SID || !config.TWILIO_AUTH_TOKEN) {
    return;
  }

  var opts = { to: config.NUMBER_TO_SEND_TO,
               from: config.TWILIO_OUTGOING_NUMBER,
               body: "watering system alarm" };

  twilio.sendMessage(opts, function(err, response) {
    if (err) { return console.error("err:", err); }
    console.log("SMS sent", response);
  });
}

// Check that water is flowing
function checkFlowOn() {
  flow.clearFlowCounter();
  flow.startFlowCounter();

  setTimeout(function() {
    if (flow.flowRate() < 1) { alert(); }
  }, 2000);
}

// Check that water isn't flowing
function checkFlowOff() {
  flow.clearFlowCounter();
  flow.startFlowCounter();

  setTimeout(function() {
    if (flow.flowRate() >= 0.5) { alert(); }
  }, 2000);
}

// Turns on the water
function turnOn() {
  log("on");
  pump.write(1);

  // check flow started after 10 seconds
  setTimeout(checkFlowOn, 10000);
}

// Turns off the water
function turnOff() {
  log("off");
  pump.write(0);

  // check flow stopped after 10 seconds
  setTimeout(checkFlowOff, 10000);
}

// Updates the watering schedule, called by web page.
function updateSchedule(data) {
  SCHEDULE = data;
  intervals.forEach(function(interval) { interval.clear(); });
  intervals = [
    later.setInterval(turnOn, onSchedule()),
    later.setInterval(turnOff, offSchedule())
  ];
}

// Starts the built-in web server for the web page
// used to set the watering system schedule
function server() {
  var app = require("express")();

  // Helper function to generate the web page's data table
  function elem(data) {
    return [
      "<tr>",
      "<td>",
      data.time,
      "</td>",
      "<td>",
      data.value,
      "</td>",
      "</tr>"
    ].join("\n");
  }

  // Serve up the main web page used to configure watering times
  function index(req, res) {
    function serve(err, data) {
      if (err) { return console.error(err); }
      res.send(data.replace("$MOISTUREDATA$", MOISTURE.map(elem).join("\n")));
    }

    fs.readFile(path.join(__dirname, "index.html"), {encoding: "utf-8"}, serve);
  }

  // Set new watering system schedule as submitted
  // by the web page using HTTP PUT
  function update(req, res) {
    updateSchedule(req.body);
    res.send("ok");
  }

  app.use(require("body-parser").json());

  app.get("/", index);
  app.get("/schedule", function(req, res) { res.json({ data: SCHEDULE }); });
  app.put("/schedule", update);
  app.get("/on", function(req, res) { turnOn(); res.send(""); });
  app.get("/off", function(req, res) { turnOff(); res.send(""); });

  app.listen(process.env.PORT || 3000);
}

// check the moisture level every 15 minutes
function monitor() {
  setInterval(function() {
    var value = moisture.value();

    MOISTURE.push({ value: value, time: new Date().toISOString() });
    log("moisture (" + value + ")");

    if (MOISTURE.length > 20) { MOISTURE.shift(); }
  }, 1 * 30 * 1000);
}

// The main function calls `server()` to start up
// the built-in web server used to configure the
// watering system's on/off times.
// It also calls the `monitor()` function which monitors
// the moisture data.
function main() {
  server();
  monitor();
}

main();