import logger from '../utils/logger.js';

export default async (req, res) => {
  logger.debug('Health check requested', { requestId: req.id });
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
};