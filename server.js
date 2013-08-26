#!/bin/env node

var async   = require('async');
var express = require('express');
var fs      = require('fs');
// use drop-in replacement for http module to follow redirects, see: http://syskall.com/how-to-follow-http-redirects-in-node-dot-js/
var http    = require('follow-redirects').http;
var StringDecoder = require('string_decoder').StringDecoder;
var url     = require('url');
var _       = require("underscore");

var resolvers = require('./resolvers');

if (typeof String.prototype.fulltrim !== 'function') {
    String.prototype.fulltrim = function() {
        return this.replace(/(?:(?:^|\n)\s+|\s+(?:$|\n))/g,'').replace(/\s+/g,' ');
    };
}
if (typeof String.prototype.trim !== 'function') {
    String.prototype.trim = function() {
        return this.replace(/^\s+|\s+$/g, '');
    }
}
if (typeof String.prototype.contains !== 'function') {
    String.prototype.contains = function(it) {
        return this.indexOf(it) != -1;
    };
}


/**
 *  Define the sample application.
 */
var App = function() {

    //  Scope.
    var self = this;


    /*  ================================================================  */
    /*  Helper functions.                                                 */
    /*  ================================================================  */

    /**
     *  Set up server IP address and port # using env variables/defaults.
     */
    self.setupVariables = function() {
        //  Set the environment variables we need.
        self.ipaddress = process.env.OPENSHIFT_NODEJS_IP;
        self.port      = process.env.OPENSHIFT_NODEJS_PORT || 8080;

        if (typeof self.ipaddress === "undefined") {
            //  Log errors on OpenShift but continue w/ 127.0.0.1 - this
            //  allows us to run/test the app locally.
            console.warn('No OPENSHIFT_NODEJS_IP var, using 127.0.0.1');
            self.ipaddress = "127.0.0.1";
        };
    };


    /**
     *  terminator === the termination handler
     *  Terminate server on receipt of the specified signal.
     *  @param {string} sig  Signal to terminate on.
     */
    self.terminator = function(sig){
        if (typeof sig === "string") {
           console.log('%s: Received %s - terminating sample app ...',
                       Date(Date.now()), sig);
           process.exit(1);
        }
        console.log('%s: Node server stopped.', Date(Date.now()) );
    };


    /**
     *  Setup termination handlers (for exit and a list of signals).
     */
    self.setupTerminationHandlers = function(){
        //  Process on exit and signals.
        process.on('exit', function() { self.terminator(); });

        // Removed 'SIGPIPE' from the list - bugz 852598.
        ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
         'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
        ].forEach(function(element, index, array) {
            process.on(element, function() { self.terminator(element); });
        });
    };


    /*  ================================================================  */
    /*  App server functions (main app logic here).                       */
    /*  ================================================================  */

    /**
     *  Create the routing table entries + handlers for the application.
     */
    self.createRoutes = function() {
        self.routes = {};

        self.routes['/query'] = function(req, res) {
            var format = req.query.format ? req.query.format : 'json';

            async.map(resolvers.resolvers, callResolver, function(err, results) {
                switch (format) {
                case 'json':
                    renderResults_JSON(res, err, results);
                    break;
                case 'html':
                    renderResults_HTML(res, err, results);
                    break;
                default:
                    res.writeHead(400); // Bad request
                    res.end('Bad request');
                }
            });
        }
    };

    function renderResults_JSON(res, err, results) {
        res.writeHead(200, {'Content-Type': 'application/json; charset=UTF-8'});

        var json = {
            error: err,
            results: results
        };
        var jsonString = JSON.stringify(json);
        res.write(jsonString);
        res.end();
    }

    function renderResults_HTML(res, err, results) {
        res.writeHead(200, {'Content-Type': 'text/html; charset=UTF-8'});

        if (err) {
            res.write('<h1>Error</h1>\n');
            res.write('Error: ' + err);
            res.end()
            return
        }

        res.write('<h1>Menus</h1\n');
        res.write('<p></p>');
        results.forEach(function(result) {
            res.write("<h2>" + result.name + "</h2>\n");
            if (result.error) {
                res.write('<p>Error: ' + result.error + '</p>')
            }

            res.write('Last update: ' + (result.date ? result.date : 'Unknown'));

            // print entries
            if (result.entries) {
                res.write('<ul>\n');
                result.entries.forEach(function(entry) {
                    res.write("<li>" + entry + "</li>\n");
                });
                res.write("</ul>\n");
            } else {
                res.write('<p>No entries.</p>');
            }
        });
        res.end();
    }

    function callResolver(resolver, callback) {
        function createResult(resolver, data) {
            result = {};
            result.name = resolver.name;
            result.link = resolver.link;
            result.data = data;
            return result;
        }

        req = http.request(resolver.request.options, function(res) {
            var decoder = new StringDecoder('utf8');

            var buffer = '';
            res.on('data', function(chunk) {
                buffer += decoder.write(chunk);
            });
            res.on('end', function() {
                data = resolver.parse(resolver, buffer);
                result = createResult(resolver, data);
                callback(null, result);
            });
        }).on('error', function(e) {
            errorMessage = 'Failed to fetch URL: ' + url + '. Message: ' + e.message;
            console.warn('Error: ' + errorMessage);
            result = createResult(resolver, {error: errorMessage});
            callback(null, result);
        });

        if (resolver.request.body) {
            req.setHeader('Content-Length', resolver.request.body.length)
            req.write(resolver.request.body);
        }
        req.end();
    }


    /**
     *  Initialize the server (express) and create the routes and register
     *  the handlers.
     */
    self.initializeServer = function() {
        self.createRoutes();
        self.server = express.createServer();
        self.server.configure(function() {
            self.server.use(express.static(__dirname + '/public'))
        });

        //  Add handlers for the app (from the routes).
        for (var r in self.routes) {
            self.server.get(r, self.routes[r]);
        }
    };


    /**
     *  Initializes the sample application.
     */
    self.initialize = function() {
        self.setupVariables();
        self.setupTerminationHandlers();

        // Create the express server and routes.
        self.initializeServer();
    };


    /**
     *  Start the server (starts up the sample application).
     */
    self.start = function() {
        //  Start the app on the specific interface (and port).
        self.server.listen(self.port, self.ipaddress, function() {
            console.log('%s: Node server started on http://%s:%d ...',
                        Date(Date.now() ), self.ipaddress, self.port);
        });
    };

};   /*  Sample Application.  */



/**
 *  main():  Main code.
 */
var app = new App();
app.initialize();
app.start();
