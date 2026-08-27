const { EXIT_CODE } = require('./lib/config');
const proxyManager = require('./lib/proxy_manager');
const actionRunner = require('./lib/action_runner');
const proxySummary = require('./lib/proxy_summary');
const { runProxyWorkflow } = require('./lib/proxy_workflow');

async function main() {
    try {
        return await runProxyWorkflow();
    } catch (error) {
        console.error('[proxy-runner] 主流程异常:', error.message);
        return EXIT_CODE.FATAL;
    }
}

if (require.main === module) {
    main()
        .then(code => process.exit(Number.isInteger(code) ? code : EXIT_CODE.FATAL))
        .catch(error => {
            console.error('[proxy-runner] fatal:', error);
            process.exit(EXIT_CODE.FATAL);
        });
}

module.exports = {
    ...proxyManager,
    ...actionRunner,
    ...proxySummary,
    main,
};
