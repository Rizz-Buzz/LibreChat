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
const { filterUniquePlugins, checkPluginAuth } = require('~/server/controllers/PluginController');

const router = express.Router();

/**
 * Get current MCP servers configuration
 * @route GET /api/mcp/config
 * @returns {object} 200 - Current MCP servers configuration
 */
router.get('/', async function (req, res) {
  try {
    const configPath = process.env.CONFIG_PATH || './librechat.yaml';
    const fileContents = await fs.readFile(configPath, 'utf8');
    const configYaml = yaml.load(fileContents);

    res.json({ mcpServers: configYaml.mcpServers || {} });
  } catch (error) {
    logger.error('Error getting mcpServers config:', error);
    res.status(500).json({ error: 'Failed to get mcpServers configuration' });
  }
});

router.post('/', async function (req, res) {
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

    // Clear both the config cache and tools cache
    const cache = getLogStores(CacheKeys.CONFIG_STORE);
    await cache.delete(CacheKeys.STARTUP_CONFIG);
    await cache.delete(CacheKeys.TOOLS);

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

    const pluginManifest = await fs.readFile(req.app.locals.paths.pluginManifest, 'utf8');

    const jsonData = JSON.parse(pluginManifest);
    await mcpManager.loadManifestTools(jsonData);

    /** @type {TPlugin[]} */
    const uniquePlugins = filterUniquePlugins(jsonData);

    const authenticatedPlugins = uniquePlugins.map((plugin) => {
      if (checkPluginAuth(plugin)) {
        return { ...plugin, authenticated: true };
      } else {
        return plugin;
      }
    });

    const tools = authenticatedPlugins.filter(
      (plugin) => req.app.locals.availableTools[plugin.pluginKey] !== undefined,
    );

    await cache.set(CacheKeys.TOOLS, tools);

    res.json({ success: true, mcpServers: config.mcpServers });
  } catch (error) {
    logger.error('Error updating mcpServers:', error);
    res.status(500).json({ error: 'Failed to update mcpServers configuration' });
  }
});

module.exports = router;