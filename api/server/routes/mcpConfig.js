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
const { checkPluginAuth, filterUniquePlugins } = require('~/server/controllers/PluginController');

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

router.put('/', async function (req, res) {
  try {
    const configPath = process.env.CONFIG_PATH || './librechat.yaml';
    const fileContents = await fs.readFile(configPath, 'utf8');
    const configYaml = yaml.load(fileContents);

    const { mcpServers } = req.body;
    if (!mcpServers || typeof mcpServers !== 'object') {
      return res.status(400).json({ error: 'Invalid mcpServers configuration' });
    }

    // Initialize mcpServers if it doesn't exist
    if (!configYaml.mcpServers) {
      configYaml.mcpServers = {};
    }

    // Merge new servers with existing ones
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      if (configYaml.mcpServers[serverName]) {
        logger.info(`Updating existing MCP server: ${serverName}`);
        // Merge with existing config, preserving any additional fields
        configYaml.mcpServers[serverName] = {
          ...configYaml.mcpServers[serverName],
          ...serverConfig,
        };
      } else {
        logger.info(`Adding new MCP server: ${serverName}`);
        configYaml.mcpServers[serverName] = serverConfig;
      }
    }

    // Save the updated config back to file
    await fs.writeFile(configPath, yaml.dump(configYaml), 'utf8');

    const config = await refreshTools(req);

    res.json({ success: true, mcpServers: config.mcpServers });
  } catch (error) {
    logger.error('Error updating mcpServers:', error);
    res.status(500).json({ error: 'Failed to update mcpServers configuration' });
  }
});

/**
 * Delete specific MCP server from configuration
 * @route DELETE /api/mcp/config/:serverName
 * @param {string} serverName - Name of the server to remove
 * @returns {object} 200 - Updated MCP servers configuration
 */
router.delete('/:serverName', async function (req, res) {
  try {
    const { serverName } = req.params;
    const configPath = process.env.CONFIG_PATH || './librechat.yaml';
    const fileContents = await fs.readFile(configPath, 'utf8');
    const configYaml = yaml.load(fileContents);

    // Check if mcpServers exists and has the server
    if (!configYaml.mcpServers || !configYaml.mcpServers[serverName]) {
      return res.status(404).json({ error: `Server "${serverName}" not found` });
    }

    // Remove the server
    delete configYaml.mcpServers[serverName];

    // If no servers left, ensure mcpServers is an empty object rather than undefined
    if (Object.keys(configYaml.mcpServers).length === 0) {
      configYaml.mcpServers = {};
      logger.info('Removed all servers from mcpServers configuration');
    }

    // Save the updated config back to file
    await fs.writeFile(configPath, yaml.dump(configYaml), 'utf8');

    // Clear the config store
    const configCache = getLogStores(CacheKeys.CONFIG_STORE);
    if (configCache) {
      try {
        await configCache.clear();
        logger.debug('Config store cleared');
      } catch (clearError) {
        logger.error('Error clearing config store:', clearError);
      }
    }

    const config = await refreshTools(req);

    res.json({
      success: true,
      message: `Server "${serverName}" removed successfully`,
      mcpServers: config.mcpServers || {}, // Ensure we always return an object
    });
  } catch (error) {
    logger.error('Error removing MCP server:', error);
    res.status(500).json({ error: 'Failed to remove MCP server' });
  }
});

const refreshTools = async (req) => {
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

  return config;
};

module.exports = router;
