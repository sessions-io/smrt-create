var http = require('http');
var express = require('express');
var session = require('express-session');
var r = require('rethinkdb');
var fs = require('fs');
var bodyParser = require('body-parser');
var handlebars = require('handlebars');
var redis = require('redis');
var RedisStore = require('connect-redis')(session);
var shortid = require('shortid');

// helper for selects
handlebars.registerHelper('select', function(selected, options) {
    return options.fn(this).replace(
        new RegExp(' value=\"' + selected + '\"'),
        '$& selected="selected"');
});

// list recent challenges
var indexTemplate = handlebars.compile(fs.readFileSync(__dirname + '/partials/index.hbs').toString());
var createTemplate = handlebars.compile(fs.readFileSync(__dirname + '/partials/create.hbs').toString());
var challengeTemplate = handlebars.compile(fs.readFileSync(__dirname + '/partials/challenge.hbs').toString());
var challengeListTemplate = handlebars.compile(fs.readFileSync(__dirname + '/partials/challenges.hbs').toString());

var app = express();
app.set('trust proxy', 1);
app.set('json spaces', 2);
app.use(session({
  cookie: {
    path: '/',
    httpOnly: true,
    secure: process.env.SECURE_COOKIE ? true : false,
    domain: '.' + process.env.ROOT_DOMAIN
  },
  resave: true,
  saveUninitialized: false,
  secret: process.env.SESSIONSTORE_SECRET,
  store: new RedisStore({
    host: process.env.SESSIONSTORE_PORT_6379_TCP_ADDR,
    port: process.env.SESSIONSTORE_PORT_6379_TCP_PORT
  })
}));

// for stripe webhooks
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}));

// route main site to launchkit landing page for now
app.get('/', function (req ,res) {

  if (!req.session.userId) { 

    // based on the profile we filled out, lookup the user to see if they exist
    r.connect({
      host: process.env.USERSTORE_PORT_28015_TCP_ADDR,
      port: process.env.USERSTORE_PORT_28015_TCP_PORT
    }, function(err, conn) {

      r.table('users').insert({ 
        created: new Date()
      }).run(conn, function (err, result) {
        if (err) {
          res.status(500);
          return res.json({
            message: 'error connecting to db'
          });
        }
        req.session.userId = result.generated_keys[0];
        res.send(indexTemplate({
          hostname: process.env.WEB_HOSTNAME
        }));
      });

    });

  } else { 
    res.send(indexTemplate({
      hostname: process.env.WEB_HOSTNAME
    }));
  }
  
});

// associate with native andorid app
app.get('/.well-known/assetlinks.json', function (req, res) {

  // TODO: add google app link associations here.

});

// associate with ios native app
var appleData = fs.readFileSync(__dirname + '/partials/apple.json.ciphered');
app.get('/apple-app-site-association', function (req, res) {

  console.log('fetching apple association');
  res.set('Content-Type', 'application/pkcs7-mime'); //'application/json');
  res.status(200);
  res.send(appleData);

});

// view my list of challenges (ensure social profile is set first)
app.get('/me/challenges', function (req, res) {

  // based on the profile we filled out, lookup the user to see if they exist
  r.connect({
    host: process.env.USERSTORE_PORT_28015_TCP_ADDR,
    port: process.env.USERSTORE_PORT_28015_TCP_PORT
  }, function(err, conn) {

    r.table('users').get(req.session.userId).run(conn, function (err, user) {

      // if the user doenst exist, create the user in the db
      if (err) {
        res.status(500);
        return res.json({
          message: 'error connecting to db'
        });
      }

      if (!user) { 
        res.status(404);
        return res.json({
          message: 'user not found'
        });
      }

      // filter alll challenges by author
      r.table('challenges').filter({
        author: user.id
      }).run(conn, function (err, cursor) {

        if (err) {
          res.status(500);
          return res.json({
            message: 'error connecting to db'
          });
        }

        cursor.toArray(function (err, results) {

          if (err) {
            res.status(500);
            return res.json({
              message: 'error connecting to db'
            });
          }

          if (err || !results) {
            res.status(404);
            return res.json({
              message: 'challenge list  not found'
            });
          }

          res.send(challengeListTemplate({
            challenges: results
          }));

        });

      });

    });

  });

});

// delete a challenge
app.get('/me/challenges/:id/delete', function (req, res) {

  // based on the profile we filled out, lookup the user to see if they exist
  r.connect({
    host: process.env.USERSTORE_PORT_28015_TCP_ADDR,
    port: process.env.USERSTORE_PORT_28015_TCP_PORT
  }, function(err, conn) {

    if (err) {
      res.status(500);
      return res.json({
        message: 'error making connection to backend database'
      });
    }

    r.table('challenges').get(req.params.id).delete().run(conn, function (err) {

      res.redirect('/me/challenges');

    });

  });

});

// creat ea new challnge
app.get('/me/challenges/create', function ( req, res ) {

  res.send(createTemplate({
    hostname: process.env.WEB_HOSTNAME,
  }));

});

app.post('/cancel', function (req, res) { 

  res.redirect('/');

});

// get a challenge (should also register this with iphone app)
app.get('/me/challenges/:id', function (req, res) {

  // based on the profile we filled out, lookup the user to see if they exist
  r.connect({
    host: process.env.USERSTORE_PORT_28015_TCP_ADDR,
    port: process.env.USERSTORE_PORT_28015_TCP_PORT
  }, function(err, conn) {

    if (err) {
      res.status(500);
      return res.json({
        message: 'error making connection to backend database'
      });
    }

    r.table('challenges').get(req.params.id).run(conn, function (err, challenge) {

      if (!challenge) {
        res.status(404);
        return res.json({
          message: 'challenge not found'
        });
      }

      if (challenge.author !== req.session.userId) {
        res.status(403);
        return res.json({
          message: 'permission denied. please login as author of this challenge'
        });
      }

      // render the challenge
      res.send(challengeTemplate({
        hostname: process.env.WEB_HOSTNAME,
        id: challenge.id,
        challenge: challenge,
        plural: challenge.segments[0].filter.minutes > 1 ? true : false
      }));

    });

  });

});

app.get('/me/challenges', function (req, res) { 

  // based on the profile we filled out, lookup the user to see if they exist
  r.connect({
    host: process.env.USERSTORE_PORT_28015_TCP_ADDR,
    port: process.env.USERSTORE_PORT_28015_TCP_PORT
  }, function(err, conn) {

    r.table('users').get(req.sessions.userId).run(conn, function (err, user) {

      // filter alll challenges by author
      r.table('challenges').filter({
        author: user.id
      }).run(conn, function (err, cursor) {

        if (err) {
          res.status(500);
          return res.json({
            message: 'error connecting to db'
          });
        }

        cursor.toArray(function (err, results) {

          if (err) {
            res.status(500);
            return res.json({
              message: 'error connecting to db'
            });
          }

          if (err || !results) {
            res.status(404);
            return res.json({
              message: 'challenge list  not found'
            });
          }

          res.send(challengeListTemplate({
            challenges: results
          }));

        });

      });

    });

  });

});

// create the challengeo n the backend
app.post('/me/challenges', function (req, res) {

  if (!req.body) { 
    res.status(400);
    return res.json({ 
      message: 'must provide challenge definition'
    });
  }

  // do validation
  if (Number(req.body.num_sessions) > Number(req.body.num_days)) {
    res.status(400);
    return res.json({
      message: 'number of sessions must be less than number of days'
    });
  }

  // based on the profile we filled out, lookup the user to see if they exist
  r.connect({
    host: process.env.USERSTORE_PORT_28015_TCP_ADDR,
    port: process.env.USERSTORE_PORT_28015_TCP_PORT
  }, function(err, conn) {

    if (err) {
      res.status(500);
      return res.json({
        message: 'error making connection to backend database'
      });
    }

    r.table('users').get(req.session.userId).run(conn, function (err, user) {

      // if the user doenst exist, create the user in the db
      if (err) {
        res.status(500);
        return res.json({
          message: 'error connecting to db'
        });
      }

      if (!user) { 
        res.status(404);
        return res.json({ 
          message: 'user not found'
        });
      }

      console.log(req.body);

      var userId = req.session.userId;

      var types = [ ];
      if (req.body.run == 'true') {
        types.push('run');
      }
      if (req.body.walk == 'true') {
        types.push('walk');
      }
      if (req.body.cycle == 'true') {
        types.push('cycle');
      }

      // the challenge
      var challenge = {
        sessions: '0.1.0',
        author: userId,
        name: req.body.name,
        summary: req.body.description,
        segments: [
          {
            type: 'sessions',
            count: Number(req.body.num_sessions),
            days: Number(req.body.num_days),
            filter: {
              types: types,
              minutes: Number(req.body.min_minutes)
            }
          }
        ]
      };

      // add challenge to rethinkdb table
      r.table('challenges').insert(challenge).run(conn, function (err, resp) {

        if (err) {
          res.status(500);
          return res.json({
            message: 'error connecting to db'
          });
        }

        // get the challenge id and pass into this url
        var challengeId = resp.generated_keys[0];

        // create a shortid to share this challenge
        var shortId = shortid.generate();

        r.table('shares').insert({
          id: shortId,
          challenge: challengeId
        }).run(conn, function (err, resp) {

          if (err) {
            res.status(500);
            return res.json({
              message: 'error generating sharable challenge url'
            });
          }

          // update the challenge with the sharable link
          r.table('challenges').get(challengeId).update({
            share: shortId
          }).run(conn, function (err, resp) {

            if (err) {
              res.status(500);
              return res.json({
                message: 'error generating sharable challenge url'
              });
            }

            // redirect to sharable url
            res.redirect('/me/challenges/' + challengeId);

          });

        });

      });

    });

  });

});

// google compute engine health check route
app.get('/ping', function (req, res) {
  res.json({
    message: 'pong'
  });
});

app.get('/logout', function (req, res) {
  req.session.destroy();
  res.redirect('/');
});

// hard coded challenges
app.get('/s/5walks', function (req, res) {

  res.json({
    "sessions":  "0.1.0",
    "name": "5 walks this week",
    "summary": "Perform 5 walks for at least 1 minute each in the next 7 days",
    "segments": [
      {
        "type": "sessions",
        "count": 5,
        "days": 7,
        "filter": {
          "types": [
            "walk"
          ],
          "minutes": 1
        }
      }
    ]
  });

});

// hard coded challenges
app.get('/s/1run', function (req, res) {

  res.json({
    "sessions":  "0.1.0",
    "name": "A single workout this week",
    "summary": "Perform a single workout of any kind for at least 1 minute in the next 7 days",
    "segments": [
      {
        "type": "sessions",
        "count": 1,
        "days": 7,
        "filter": {
          "types": [
            "run" ,
            "walk",
            "cycle"
          ],
          "minutes": 1
        }
      }
    ]
  });

});

app.get('/s/c25k', function (req, res) {

  res.json({
    "sessions":  "0.1.0",
    "name": "The couch to 5k running plan",
    "summary": "Start your 5k training with just a few minutes each week. Each session should take about 20 or 30 minutes, three times a week. That just happens to be the same amount of moderate exercise recommended by numerous studies for optimum fitness. This program will get you fit.",
    "segments": [
      {
        "type": "sessions",
        "count": 3,
        "days": 7,
        "filter": {
          "types": [
            "run" ,
            "walk"
          ],
          "minutes": 25
        }
      },
      {
        "type": "sessions",
        "count": 3,
        "days": 7,
        "filter": {
          "types": [
            "run" ,
            "walk"
          ],
          "minutes": 25
        }
      },
      {
        "type": "sessions",
        "count": 3,
        "days": 7,
        "filter": {
          "types": [
            "run" ,
            "walk"
          ],
          "minutes": 25
        }
      },
      {
        "type": "sessions",
        "count": 3,
        "days": 7,
        "filter": {
          "types": [
            "run" ,
            "walk"
          ],
          "minutes": 25
        }
      },
      {
        "type": "sessions",
        "count": 3,
        "days": 7,
        "filter": {
          "types": [
            "run" ,
            "walk"
          ],
          "minutes": 25
        }
      },
      {
        "type": "sessions",
        "count": 3,
        "days": 7,
        "filter": {
          "types": [
            "run" ,
            "walk"
          ],
          "minutes": 25
        }
      },
      {
        "type": "sessions",
        "count": 3,
        "days": 7,
        "filter": {
          "types": [
            "run" ,
            "walk"
          ],
          "minutes": 25
        }
      },
      {
        "type": "sessions",
        "count": 3,
        "days": 7,
        "filter": {
          "types": [
            "run" ,
            "walk"
          ],
          "minutes": 25
        }
      },
      {
        "type": "sessions",
        "count": 3,
        "days": 7,
        "filter": {
          "types": [
            "run" ,
            "walk"
          ],
          "minutes": 25
        }
      }
    ]
  });

});

app.get('/s/365in365', function (req, res) {

  res.json({
    "sessions":  "0.1.0",
    "name":  "Zuckerberg's 365 in 365",
    "summary":  "This challenge was first proposed by Mark Zuckerberg to his Facebook followers. Run for 365 miles in 365 days. Simple right?",
    "segments": [
      {
        "type": "miles",
        "count": 365,
        "days": 365,
        "filter": {
          "types": [
            "run"
          ]
        }
      }
    ]
  });

});

app.get('/s/:id', function (req, res) {

  var isIphone = req.headers['user-agent'].indexOf('iPhone') != -1;

  r.connect({
    host: process.env.USERSTORE_PORT_28015_TCP_ADDR,
    port: process.env.USERSTORE_PORT_28015_TCP_PORT
  }, function (err, conn) {

    if (err) {
      res.status(500);
      return res.json({
        message: 'error making connection to backend database'
      });
    }

    r.table('shares').get(req.params.id).run(conn, function (err, challenge) {

      if (err || !challenge) {
        res.status(404);
        return res.json({
          message: 'challenge not found'
        });
      }

      r.table('challenges').get(challenge.challenge).run(conn, function (err, challenge) {

        if (!challenge) {
          res.status(404);
          return res.json({
            message: 'challenge not found'
          });
        }

        res.json(challenge);

      });

    });

  });

});

var server = http.createServer(app);
server.listen(9000);
