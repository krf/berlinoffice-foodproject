#!/bin/env node

var async   = require('async');
var cheerio = require('cheerio');
var express = require('express');
var fs      = require('fs');
// use drop-in replacement for http module to follow redirects, see: http://syskall.com/how-to-follow-http-redirects-in-node-dot-js/
var http    = require('follow-redirects').http;
var sanitizer = require("sanitizer");
var StringDecoder = require('string_decoder').StringDecoder;
var url     = require('url');

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
     *  Populate the cache.
     */
    self.populateCache = function() {
        if (typeof self.zcache === "undefined") {
            self.zcache = { 'index.html': '' };
        }

        //  Local cache for static content.
        self.zcache['index.html'] = fs.readFileSync('./index.html');
    };


    /**
     *  Retrieve entry (content) from cache.
     *  @param {string} key  Key identifying content to retrieve from cache.
     */
    self.cache_get = function(key) { return self.zcache[key]; };


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

    function stripHTML(html) {
        var clean = sanitizer.sanitize(html, function (str) {
            return str;
        });
        // Remove all remaining HTML tags.
        clean = clean.replace(/<(?:.|\n)*?>/gm, "");

        // RegEx to remove needless newlines and whitespace.
        // See: http://stackoverflow.com/questions/816085/removing-redundant-line-breaks-with-regular-expressions
        clean = clean.replace(/(?:(?:\r\n|\r|\n)\s*){2,}/ig, "\n");

        // Return the final string, minus any leading/trailing whitespace.
        return clean.trim();
    }

    /**
     *  Create the routing table entries + handlers for the application.
     */
    self.createRoutes = function() {
        self.routes = {};

        var wauData = 'pid=5603160&url=wauberlin&nurl=&is_following=false&design=montessori&template=escher';
        var services = [
            {
                name: 'www.cafe-rundum.de',
                body: null,
                options: {
                    host: 'www.cafe-rundum.de',
                    path: '/deutsch/speisekarte.html'
                },
                parse: function(service, data) {
                    var dateRegex = /\w+, ([0-9\.]+)/;

                    $ = cheerio.load(data);
                    var entries = [];
                    var date = null;
                    var currentSection = -1;
                    $('#content').find('tr').each(function(i, elem) {
                        if ($(this).find('strong').length > 0) {
                            // header found
                            currentSection++;
                            if (currentSection == 0) {
                                var result = $(this).text().match(dateRegex);
                                if (result) {
                                    date = result[1];
                                }
                            }
                        } else {
                            // entry found - only push items in case we're in section 0
                            if (currentSection == 0) {
                                var text = $(this).text().fulltrim().replace(/&nbsp;/g,'');
                                if (text.length > 0) {
                                    entries.push(text);
                                }
                            }

                        }
                    });

                    searchResult = {}
                    searchResult.name = this.name;
                    searchResult.date = date;
                    searchResult.entries = entries;
                    return searchResult;
                }
            },
            {
                name: 'www.restaurant-so.de',
                body: null,
                options: {
                    host: 'www.restaurant-so.de',
                    path: '/deutsch/tageskarte.htm'
                },
                parse: function(service, data) {
                    // unfortunately restaurant-so's HTML is *completely* messed up
                    // there's no clear DOM structure, so we need to parse the content based
                    // on the visual text

                    // capture groups: (date, information, string containing the menu)
                    var splitPageRegex = /Tageskarte f&uuml;r den ([0-9\.]+)\s+\*([^\*]+)\*\s+(\*.+)$/;
                    // get the raw text, fully cleaned up from whitespace
                    var text = stripHTML(data).replace(/&nbsp;/g,'').fulltrim();
                    var result = text.match(splitPageRegex);
                    var rawEntries = result[3];
                    var entries = rawEntries.split('&#8364;') // split on euro-sign
                        .map(function(rawEntry) { return rawEntry.fulltrim(); })
                        .filter(function(rawEntry) { return rawEntry.length > 0; })
                        .map(function(rawEntry) { return rawEntry + ' &#8364;'; });

                    searchResult = {};
                    searchResult.name = this.name;
                    searchResult.date = result[1];
                    searchResult.info = result[2];
                    searchResult.entries = entries;
                    return searchResult;
                }
            },
            {
                name: 'www.wau-berlin.de',
                body: wauData,
                options: {
                    host: 'www.wau-berlin.de',
                    path: '/designs/escher/entry-detail.php',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                },
                parse: function(service, data) {
                    var json = JSON.parse(data);
                    var html = json.content;
                    $ = cheerio.load(html);
                    var rawEntries = $('div.project_content')
                        .html().split(/<br[^>]*>\s*<br[^>]*>/gi);
                    var entries = rawEntries.map(function(rawEntry) {
                        return rawEntry.fulltrim();
                    }).filter(function(rawEntry) {
                        return rawEntry.length > 0
                            && !rawEntry.contains('TAGESKARTE')
                            && !rawEntry.contains('ABENDKARTE');
                    });

                    searchResult = {}
                    searchResult.name = this.name;
                    searchResult.entries = entries;
                    return searchResult;
                }
            }
        ];

        self.routes['/results'] = function(req, res) {
            res.writeHead(200, {'Content-Type': 'text/html; charset=UTF-8'});

            async.map(services, callService, function(err, results) {
                if (err) {
                    res.write('<h1>Error</h1>\n');
                    res.write('Error: ' + err);
                    res.end()
                    return
                }

                console.log("Results:");
                console.dir(results);

                // print results
                renderResults(res, results);
                res.end();
            });
        }

        self.routes['/json/results'] = function(req, res) {
            res.writeHead(200, {'Content-Type': 'application/json; charset=UTF-8'});

            async.map(services, callService, function(err, results) {
                var json = {
                    error: err,
                    results: results
                };

                var jsonString = JSON.stringify(json);
                res.write(jsonString);
                res.end();
            });
        }

        function renderResults(res, results) {
            res.write('<h1>Results</h1\n');
            res.write('<p>Up-to-date menus</p>');
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
        }

        function callService(service, callback) {
            req = http.request(service.options, function(res) {
                var decoder = new StringDecoder('utf8');

                var buffer = '';
                res.on('data', function(chunk) {
                    buffer += decoder.write(chunk);
                });
                res.on('end', function() {
                    searchResult = service.parse(service, buffer);
                    callback(null, searchResult);
                });
            }).on('error', function(e) {
                errorMessage = 'Failed to fetch URL: ' + url + '. Message: ' + e.message;
                console.warn('Error: ' + errorMessage);
                callback(null, {error: errorMessage})
            });

            if (service.body) {
                req.setHeader('Content-Length', service.body.length)
                req.write(service.body);
            }
            req.end();
        }
    };


    /**
     *  Initialize the server (express) and create the routes and register
     *  the handlers.
     */
    self.initializeServer = function() {
        self.createRoutes();
        self.app = express.createServer();

        //  Add handlers for the app (from the routes).
        for (var r in self.routes) {
            self.app.get(r, self.routes[r]);
        }
    };


    /**
     *  Initializes the sample application.
     */
    self.initialize = function() {
        self.setupVariables();
        self.populateCache();
        self.setupTerminationHandlers();

        // Create the express server and routes.
        self.initializeServer();
    };


    /**
     *  Start the server (starts up the sample application).
     */
    self.start = function() {
        //  Start the app on the specific interface (and port).
        self.app.listen(self.port, self.ipaddress, function() {
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
