// GET /api/health - lets the bot's `check` see that the dashboard is up. Public on purpose, returns nothing but {ok:true}.
'use strict';
const { send } = require('../lib/http.js');

module.exports = (req, res) => send(res, 200, { ok: true });
