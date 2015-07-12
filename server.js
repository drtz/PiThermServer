// server.js - NodeJS server for the PiThermServer project.

/* 

Parses data from DS18B20 temperature sensor and serves as a JSON object.
Uses node-static module to serve a plot of current temperature (uses highcharts).

Tom Holderness 03/01/2013
Ref: www.cl.cam.ac.uk/freshers/raspberrypi/tutorials/temperature/
*/

// Load node modules
var fs = require('fs'),
    sys = require('sys'),
    http = require('http'),
    sqlite3 = require('sqlite3'),
    Sendgrid = require('sendgrid'),
    nodestatic = require('node-static');

var sendgrid;
if (process.env.SENDGRID_USER && process.env.SENDGRID_PASSWORD) {
	sendgrid = Sendgrid(process.env.SENDGRID_USER, process.env.SENDGRID_PASSWORD);
	console.log('done');
}

// Setup static server for current directory
var staticServer = new nodestatic.Server(".");

// Setup database connection for logging
var db = new sqlite3.Database('./piTemps.db');

// default to 60 minute notification throttle
var notificationThrottle = process.env.NOTIFICATION_THROTTLE || 60;
var lastNotificationTime = 0;

function sendOkayNotification(record) {
	var subject = 'Temperature is back within desired range';
	var text = 'Current temperature is ' + record.celsius + ' C';
	lastNotificationTime = 0;

	sendNotification(subject, text);
}

function sendFailNotification(failedRecords) {
	var text;
	var subject;
	var temp = failedRecords[failedRecords.length - 1].celsius + ' C';
	if (failedRecords.length === 1) {
		text = 'Last temperature reading was out of desired range: ' + temp;
		subject = 'Temperature has gone out of desired range';
		lastNotificationTime = Date.now();
	} else {
		text = 'Last ' + failedRecords.length + ' temperature readings were out of range \n' +
			'Current temperature is ' + temp;
		subject = 'Temperature is still out of desired range';
		lastNotificationTime = Date.now();
	}

	lastNotificationTime = Date.now();

	sendNotification(subject, text);
}

function sendNotification(subject, text) {

	if (!sendgrid) {
		console.log('Not sending notification: No sendgrid credentials');
		return;
	}

	var toEmail = process.env.NOTIFICATION_TO_EMAIL;
	var fromEmail = process.env.NOTIFICATION_FROM_EMAIL;
	if (!toEmail || !fromEmail) {
		console.log('Not sending notification: Notification email not specified');
		return;
	}

	var email = new sendgrid.Email({
		from: fromEmail,
		subject: subject,
		text: text
	});
	
	toEmail.split(',').forEach(email.addTo, email);

	sendgrid.send(email, function(err, json) {
		if (err) {
			console.log('Sendgrid error: ' + JSON.stringify(err));
			return;
		}
		console.log('Sent notification email to ' + toEmail);
	});
}

// Write a single temperature record in JSON format to database table.
function insertTemp(data){
   // data is a javascript object   
   var statement = db.prepare("INSERT INTO temperature_records VALUES (?, ?)");
   // Insert values into prepared statement
   statement.run(data.temperature_record[0].unix_time, data.temperature_record[0].celsius);
   // Execute the statement
   statement.finalize();
}

// Read current temperature from sensor
function readTemp(callback){
	fs.readFile('/sys/bus/w1/devices/' + process.env.SENSOR_ID + '/w1_slave', function(err, buffer) {
		if (err) {
			console.error(err);
			process.exit(1);
		}

		// Read data from file (using fast node ASCII encoding).
		var data = buffer.toString('ascii').split(" "); // Split by space

		// Extract temperature from string and divide by 1000 to give celsius
		var temp  = parseFloat(data[data.length-1].split("=")[1])/1000.0;

		// Round to one decimal place
		temp = Math.round(temp * 10) / 10;

		// Add date/time to temperature
		var data = {
			temperature_record:[{
			unix_time: Date.now(),
			celsius: temp
		}]};

		// Execute call back with data
		callback(data);
	});
};

// Create a wrapper function which we'll use specifically for logging
function logTemp(interval) {
	function readAndNotify() {
		readTemp(function(data) {
			insertTemp(data);
			var record = data.temperature_record[0];
			console.log(record.unix_time + ' ' + record.celsius);
			if (record.celsius < process.env.RANGE_MIN || record.celsius > process.env.RANGE_MAX) {
				selectRecentFailures(function(err, records) {
					if (err) {
						console.log('error: ' + JSON.stringify(err));
					}
					if (Date.now() > lastNotificationTime + notificationThrottle * 60 * 1000) {
						sendFailNotification(records);
					}
				});
			} else {
				if (lastNotificationTime) {
					sendOkayNotification(record);
				}
			}
		});
	}
	readAndNotify(insertTemp);
	setInterval(readAndNotify, interval, insertTemp);
};

function selectLastSuccessful(callback) {
	db.all("SELECT * FROM temperature_records WHERE celsius >= ? AND celsius <= ? ORDER BY unix_time DESC LIMIT 1;",
		process.env.RANGE_MIN, process.env.RANGE_MAX, function(err, rows) {
		if (err) {
			return callback(err);
		} else if (rows.length === 0) {
			return callback(null, null);
		}
		callback(null, rows[0]);
	});
}

function selectSince(time, callback) {
	db.all("SELECT * FROM temperature_records WHERE unix_time > ? ORDER BY unix_time ASC;",
		time, function(err, rows) {
		if (err) {
			return callback(err);
		}
		callback(null, rows);
	});
}

function selectRecentFailures(callback) {
	selectLastSuccessful(function(err, record) {
		if (err) {
			return callback(err);
		}
		if (!record) {
			return selectSince(0, callback);
		}
		selectSince(record.unix_time, callback);
	});
}

// Get temperature records from database
function selectTemp(num_records, start_date, callback){
   // - Num records is an SQL filter from latest record back trough time series, 
   // - start_date is the first date in the time-series required, 
   // - callback is the output function
   db.all("SELECT * FROM (SELECT * FROM temperature_records WHERE unix_time > (strftime('%s',?)*1000) ORDER BY unix_time DESC LIMIT ?) ORDER BY unix_time;", start_date, num_records,
      function(err, rows){
         if (err){
			   response.writeHead(500, { "Content-type": "text/html" });
			   response.end(err + "\n");
			   console.log('Error serving querying database. ' + err);
			   return;
				      }
         data = {temperature_record:[rows]}
         callback(data);
   });
};

// Setup node http server
var server = http.createServer(function(request, response) {
	// Grab the URL requested by the client and parse any query options
	var url = require('url').parse(request.url, true);
	var pathfile = url.pathname;
	var query = url.query;

	// Test to see if it's a database query
	if (pathfile == '/temperature_query.json'){
		// Test to see if number of observations was specified as url query
		if (query.num_obs){
		   var num_obs = parseInt(query.num_obs);
		}
		else{
		// If not specified default to 20. Note use -1 in query string to get all.
		   var num_obs = -1;
		}
		if (query.start_date){
		   var start_date = query.start_date;
		}
		else{
		   var start_date = '1970-01-01T00:00';
		}   
		// Send a message to console log
		console.log('Database query request from '+ request.connection.remoteAddress +' for ' + num_obs + ' records from ' + start_date+'.');
		// call selectTemp function to get data from database
		selectTemp(num_obs, start_date, function(data){
			response.writeHead(200, { "Content-type": "application/json" });
			response.end(JSON.stringify(data), "ascii");
		});
		return;
	}

	// Test to see if it's a request for current temperature   
	if (pathfile == '/temperature_now.json') {
	      readTemp(function(data){
		      response.writeHead(200, { "Content-type": "application/json" });		
		      response.end(JSON.stringify(data), "ascii");
	      });
	      return;
	}

	// Handler for favicon.ico requests
	if (pathfile == '/favicon.ico'){
	      response.writeHead(200, {'Content-Type': 'image/x-icon'});
	      response.end();

	      // Optionally log favicon requests.
	      //console.log('favicon requested');
	      return;
	} else {
	      // Print requested file to terminal
	      console.log('Request from '+ request.connection.remoteAddress +' for: ' + pathfile);

	      // Serve file using node-static			
	      staticServer.serve(request, response, function (err, result) {
		      if (err) {
			      // Log the error
			      sys.error("Error serving " + request.url + " - " + err.message);

			      // Respond to the client
			      response.writeHead(err.status, err.headers);
			      response.end('Error 404 - file not found');
			      return;
		      }
		      return;	
	      });
	}
});

if (!process.env.SENSOR_ID) {
	throw new Error('SENSOR_ID environment variable must be defined');
}

console.log('Temp Sensor: ' + process.env.SENSOR_ID);

// Start temperature logging (every 5 min).
var msecs = process.env.LOG_INTERVAL || (60 * 5) * 1000; // log interval duration in milliseconds
logTemp(msecs);
// Send a message to console
console.log('Server is logging to database at '+msecs+'ms intervals');
// Enable server
var httpPort = process.env.HTTP_PORT;
server.listen(httpPort)
server.on('error', function(err) {
		console.log('ERROR: ' + JSON.stringify(err, null, ' '));
		server.close();
		process.exit(1);
		});
server.on('listening', function() {
	console.log('Server listening on localhost:' + httpPort);
});
