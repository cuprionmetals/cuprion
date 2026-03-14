import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { v4 as uuidv4 } from 'uuid';
import routes from './routes/index.js';
import { errorMiddleware } from './middleware/index.js';
import logger from './utils/logger.js';

const app = express();

// Add request ID for tracking
app.use((req, res, next) => {
  req.id = uuidv4();
  logger.info(`→ ${req.method} ${req.path}`, { requestId: req.id });
  next();
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
});

process.on('SIGINT', async () => {
  logger.info('Interrupted');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM signal received');
  await new Promise(resolve => setTimeout(resolve, 3000));
  logger.info('Exiting');
  process.exit();
});

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN,
  credentials: true,
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request timeout middleware - 60 seconds for most endpoints
app.use((req, res, next) => {
  res.setTimeout(60000, () => {
    logger.error('Request timeout', {
      method: req.method,
      path: req.path,
      requestId: req.id,
    });
    res.status(504).json({
      error: 'Request timeout - operation took too long',
      status: 504,
      requestId: req.id,
    });
  });
  next();
});

app.use('/', routes());

app.use(errorMiddleware);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const port = process.env.PORT || 3001;

app.listen(port, () => {
  logger.info(`🚀 API Server running on http://localhost:${port}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`CORS Origin: ${process.env.CORS_ORIGIN}`);
});

export default app;