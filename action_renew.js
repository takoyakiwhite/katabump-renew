const { run, EXIT_CODE } = require('./lib/renew_engine');

run().then((code) => {
    process.exit(Number.isInteger(code) ? code : EXIT_CODE.FATAL);
}).catch((error) => {
    console.error('[KataBump] fatal:', error);
    process.exit(EXIT_CODE.FATAL);
});
