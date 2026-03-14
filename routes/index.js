import { Router } from 'express';
import healthCheck from './health-check.js';
import qrRouter from './qr.js';

const router = Router();

export default () => {
    router.get('/health', healthCheck);
    router.use('/qr', qrRouter);

    return router;
};