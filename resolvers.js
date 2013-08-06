var cheerio = require('cheerio');
var util = require('./util');

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
                        var match = $(this).text().match(dateRegex);
                        if (match) {
                            date = match[1];
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
        link: 'http://www.wau-berlin.de/Tages-Abendkarte',
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
                return rawEntry.fulltrim();
            }).filter(function(rawEntry) {
                return rawEntry.length > 0
                    && !rawEntry.contains('TAGESKARTE')
                    && !rawEntry.contains('ABENDKARTE');
            });

            result = {}
            result.entries = entries;
            return result;
        }
    }
];

exports.resolvers = resolvers;
