import 'dotenv/config';
import PocketBase from 'pocketbase';
import logger from './logger.js';

const pbUrl = process.env.POCKETBASE_URL;
const adminEmail = process.env.POCKETBASE_ADMIN_EMAIL;
const adminPassword = process.env.POCKETBASE_ADMIN_PASSWORD;

if (!pbUrl) {
  throw new Error('POCKETBASE_URL environment variable is not set');
}

logger.info(`Initializing PocketBase client with URL: ${pbUrl}`);
logger.debug('PocketBase credentials check:', {
  POCKETBASE_URL: pbUrl,
  POCKETBASE_ADMIN_EMAIL: adminEmail ? `${adminEmail.substring(0, 5)}***` : 'NOT SET',
  POCKETBASE_ADMIN_PASSWORD: adminPassword ? `${adminPassword.substring(0, 5)}***` : 'NOT SET',
});

const pb = new PocketBase(pbUrl);

// Set connection timeout to 10 seconds
pb.httpClientConfig = {
  timeout: 10000, // 10 seconds
  maxRetries: 2,
};

// Test connection on initialization with timeout
const testConnection = async () => {
  try {
    logger.info('🔍 Testing PocketBase connection...');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const health = await pb.health.check();
    clearTimeout(timeoutId);
    
    logger.info('✓ PocketBase connection successful', {
      url: pbUrl,
      healthStatus: health.code,
      healthMessage: health.message,
    });
  } catch (error) {
    logger.warn('⚠ PocketBase connection test failed (will retry on first request)', {
      message: error.message,
      url: pbUrl,
      code: error.code,
      errorType: error.constructor.name,
    });
  }
};

// Run connection test asynchronously (don't block startup)
testConnection().catch((error) => {
  logger.error('✗ PocketBase connection test error', {
    message: error.message,
    errorType: error.constructor.name,
  });
});

export default pb;