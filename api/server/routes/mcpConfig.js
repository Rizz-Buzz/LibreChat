const express = require('express');
const { CacheKeys } = require('librechat-data-provider');
const { getMCPManager } = require('~/config');
const { getLogStores } = require('~/cache');
const { logger } = require('~/config');
const fs = require('fs/promises');
const yaml = require('js-yaml');
const loadCustomConfig = require('~/server/services/Config/loadCustomConfig');
const { loadAndFormatTools } = require('~/server/services/ToolService');
const paths = require('~/config/paths');

const router = express.Router();

router.put('/', async function (req, res) {
  try {
    const configPath = process.env.CONFIG_PATH || './librechat.yaml';
    const fileContents = await fs.readFile(configPath, 'utf8');
    const configYaml = yaml.load(fileContents);

    const { mcpServers } = req.body;
    if (!mcpServers || typeof mcpServers !== 'object') {
      return res.status(400).json({ error: 'Invalid mcpServers configuration' });
    }

    // Update the config object
    configYaml.mcpServers = mcpServers;

    // Save the updated config back to file
    await fs.writeFile(configPath, yaml.dump(configYaml), 'utf8');

    // Clear the startup config cache
    const cache = getLogStores(CacheKeys.CONFIG_STORE);
    await cache.delete(CacheKeys.STARTUP_CONFIG);

    // Reinitialize MCP with new configuration
    /** @type {TCustomConfig}*/
    const config = (await loadCustomConfig()) ?? {};

    /** @type {Record<string, FunctionTool> */
    const filteredTools = config.filteredTools;
    const includedTools = config.includedTools;

    const availableTools = loadAndFormatTools({
      adminFilter: filteredTools,
      adminIncluded: includedTools,
      directory: paths.structuredTools,
    });
    const mcpManager = await getMCPManager();
    await mcpManager.disconnectAll();
    await mcpManager.initializeMCP(config.mcpServers);
    await mcpManager.mapAvailableTools(availableTools);

    res.json({ success: true, mcpServers: config.mcpServers });
  } catch (error) {
    logger.error('Error updating mcpServers:', error);
    res.status(500).json({ error: 'Failed to update mcpServers configuration' });
  }
});

module.exports = router;