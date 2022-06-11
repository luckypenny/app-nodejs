let dd_tracer = undefined;

if (process.env.DD_AGENT_HOST) {
  console.log('APM Run... DataDog Agent Host : %o', process.env.DD_AGENT_HOST);
  dd_tracer = require('dd-trace').init();
}

require('./src/_boot');

const _app = require(`./app2`);
_app.main();
