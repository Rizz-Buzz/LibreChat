const express = require('express');
const { CacheKeys } = require('librechat-data-provider');
const { getLogStores } = require('~/cache');
const { logger } = require('~/config');
const fs = require('fs/promises');
const yaml = require('js-yaml');

const router = express.Router();

router.put('/', async function (req, res) {
  try {
    const configPath = process.env.CONFIG_PATH || './librechat.yaml';
    const fileContents = await fs.readFile(configPath, 'utf8');
    const config = yaml.load(fileContents);

    const { mcpServers } = req.body;
    if (!mcpServers || typeof mcpServers !== 'object') {
      return res.status(400).json({ error: 'Invalid mcpServers configuration' });
    }

    // Update the config object
    config.mcpServers = mcpServers;

    // Save the updated config back to file
    await fs.writeFile(configPath, yaml.dump(config), 'utf8');

    // Clear the startup config cache to ensure changes take effect
    const cache = getLogStores(CacheKeys.CONFIG_STORE);
    await cache.delete(CacheKeys.STARTUP_CONFIG);

    res.json({ success: true, mcpServers: config.mcpServers });
  } catch (error) {
    logger.error('Error updating mcpServers:', error);
    res.status(500).json({ error: 'Failed to update mcpServers configuration' });
  }
});

module.exports = router;