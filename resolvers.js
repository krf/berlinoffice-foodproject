var cheerio = require('cheerio');
var util    = require('./util');
var _       = require("underscore");

var resolvers = [
    {
        name: 'www.cafe-rundum.de',
        link: 'http://www.cafe-rundum.de/deutsch/speisekarte.html',
        request: {
            options: {
                host: 'www.cafe-rundum.de',
                path: '/deutsch/speisekarte.html'
            },
            body: null
        },
        parse: function(service, data) {
            // capture groups: (date)
            var startMenuSectionRegex = /\w+, ([0-9\.]+)/;
            var endMenuSectionString = "unsere salate";

            $ = cheerio.load(data);
            var entries = [];
            var date = null;
            var inMenuSection = false;
            $('#content').find('tr').each(function(i, elem) {
                if ($(this).find('strong').length > 0) {
                    if (match = $(this).text().match(startMenuSectionRegex)) {
                        // menu section found
                        inMenuSection = true;
                        date = match[1];
                    } else if ($(this).text().contains(endMenuSectionString)) {
                        return false; // break out each-loop
                    }
                } else if (inMenuSection) {
                    // entry found - only push items in case we're in the menu section
                    var text = $(this).text().fulltrim().replace(/&nbsp;/g,'');
                    if (text.length > 0) {
                        entries.push(text);
                    }
                }
            });

            result = {}
            result.date = date;
            result.entries = entries;
            return result;
        }
    },
    {
        name: 'www.restaurant-so.de',
        link: 'http://www.restaurant-so.de/deutsch/tageskarte.htm',
        request: {
            options: {
                host: 'www.restaurant-so.de',
                path: '/deutsch/tageskarte.htm'
            },
            body: null,
        },
        parse: function(service, data) {
            result = {};

            // unfortunately restaurant-so's HTML is *completely* messed up
            // there's no clear DOM structure, so we need to parse the content based
            // on the visual text

            // capture groups: (date, information, string containing the menu)
            var splitPageRegex = /Tageskarte f&uuml;r den ([0-9\.]+)\s+(\*.+)$/;
            // get the raw text, fully cleaned up from whitespace
            var text = util.stripHTML(data).replace(/&nbsp;/g,'').fulltrim();
            var match = text.match(splitPageRegex);
            if (!match) {
                result.error = 'Failed to parse webpage';
                return result;
            }

            var rawEntries = match[2];
            var entries = rawEntries.split('&#8364;') // split on euro-sign
                .map(function(rawEntry) { return rawEntry.replace(/\*/, '').fulltrim(); })
                .filter(function(rawEntry) { return rawEntry.length > 0; })
                .map(function(rawEntry) { return rawEntry + ' &#8364;'; });

            result.date = match[1];
            result.entries = entries;
            return result;
        }
    },
    {
        name: 'www.wau-berlin.de',
        link: 'http://www.wau-berlin.de/Speisen',
        request: {
            options: {
                host: 'www.wau-berlin.de',
                path: '/designs/escher/entry-detail.php',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            },
            body: 'pid=5603160&url=wauberlin&nurl=&is_following=false&design=montessori&template=escher'
        },
        parse: function(service, data) {
            var json = JSON.parse(data);
            var html = json.content;
            $ = cheerio.load(html);
            var rawEntries = $('div.project_content')
                .html().split(/<br[^>]*>\s*<br[^>]*>/gi);
            var entries = rawEntries.map(function(rawEntry) {
                return rawEntry.fulltrim()});

            var filteredEntries = [];
            for (var i = 0; i < entries.length; ++i) {
                entry = entries[i];
                if (entry.contains('TAGESKARTE') || entry.contains('MITTAGSTISCH')) {
                    continue; // skip
                }
                if (entry === "") {
                    continue; // skip empty entries
                }
                if (entry.contains('ABENDKARTE')) {
                    break; // abort, we're not interested in the ABENDKARTE
                }
                filteredEntries.push(entry);
            }

            result = {}
            result.entries = filteredEntries;
            return result;
        }
    },
    {
        name: 'www.cafe-lentz.de/',
        link: 'http://www.cafe-lentz.de/karte/15-karte/wochenkarte/42-wochenkarte',
        request: {
            options: {
                host: 'www.cafe-lentz.de',
                path: '/karte/15-karte/wochenkarte/42-wochenkarte'
            },
            body: null,
        },
        parse: function(service, data) {
            $ = cheerio.load(data);
            var table = $('tbody').filter(function(i, el) {
                return $(this).html().contains('Mittagstisch');
            }).first();

            var entries = [];
            var rows = table.find('td')
            rows.each(function(i, el) {
                var text = $(this).text().fulltrim();
                if (text == "" || text.contains('X') || text.contains('Vorbestellung') || text.contains('Wochenkarte'))
                    return;

                // don't do more processing, just add the html from the original site
                entries.push($(this).html())
            });

            // retrieve date information
            // example: <span style="font-size: 14px;">Wochenkarte vom 18.08. - 22.08.</span>
            var dateRegex = /<span.*Wochenkarte vom (.*?)<\/span>/;
            var dateMatches = table.html().match(dateRegex);

            var result = {}
            result.date = dateMatches ? dateMatches[1] : null;
            result.entries = entries;
            return result;
        }
    },
    {
        name: 'www.lpg-biomarkt.de',
        link: 'http://www.lpg-biomarkt.de/unsere-markte-herzlich-willkommen/mehringdamm/#unser-angebot',
        request: {
            options: new function() {
                var date = new Date().toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ

                this.host = 'www.lpg-biomarkt.de',
                this.path = '/wp-content/uploadds/' + date.slice(0, 4) + '/' + date.slice(5,7) + '/me' + date.slice(8,10) + '.jpg'
            }
        },
        onResponse: function(res) {
            if (res.statusCode != 200) {
                var imageUrl = this.request.options.host + this.request.options.path
                return "Konnte heutige Tageskarte nicht finden (@ " + imageUrl + ")";
            }
            return null; // ok
        },
        parse: function(service, data) {
            var imageUrl = "http://" + this.request.options.host + this.request.options.path;

            var result = {};
            result.html = '<a href="' + imageUrl + '">'
                + '<img style="width: auto; height: 600px" src="' + imageUrl + '"/>'
                + '</a>'
            return result;
        }
    }
];

exports.resolvers = resolvers;
