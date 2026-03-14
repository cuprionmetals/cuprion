import express from 'express';
import QRCode from 'qrcode';
import ExcelJS from 'exceljs';
import pb from '../utils/pocketbase.js';
import logger from '../utils/logger.js';
import { withTimeout, withRetry } from '../utils/timeout.js';

const router = express.Router();
const OPERATION_TIMEOUT = 120000; // 120 seconds per operation

// Log POCKETBASE_URL on initialization
logger.info(`QR Routes initialized. POCKETBASE_URL is set to: ${process.env.POCKETBASE_URL}`);

// Health check - Test PocketBase connection
const checkPocketBaseHealth = async () => {
  logger.info('🔍 Attempting PocketBase health check...');
  const health = await withTimeout(
    pb.health.check(),
    OPERATION_TIMEOUT,
    'PocketBase health check'
  );
  logger.info('✓ PocketBase health check successful', {
    status: health.code,
    message: health.message,
    url: process.env.POCKETBASE_URL,
  });
  return true;
};

// Authenticate PocketBase admin with comprehensive debugging
const authenticateAdmin = async () => {
  const adminEmail = process.env.POCKETBASE_ADMIN_EMAIL;
  const adminPassword = process.env.POCKETBASE_ADMIN_PASSWORD;

  logger.info('🔐 [AUTH] Starting PocketBase admin authentication process...');
  logger.debug('[AUTH] Environment variables check:', {
    POCKETBASE_URL: process.env.POCKETBASE_URL,
    POCKETBASE_ADMIN_EMAIL: adminEmail ? `${adminEmail.substring(0, 5)}***` : 'NOT SET',
    POCKETBASE_ADMIN_PASSWORD: adminPassword ? `${adminPassword.substring(0, 5)}***` : 'NOT SET',
  });

  // Validate environment variables
  if (!adminEmail || !adminPassword) {
    const missingVars = [];
    if (!adminEmail) missingVars.push('POCKETBASE_ADMIN_EMAIL');
    if (!adminPassword) missingVars.push('POCKETBASE_ADMIN_PASSWORD');
    
    const errorMsg = `Missing required environment variables: ${missingVars.join(', ')}`;
    logger.error('[AUTH] ✗ Admin authentication prerequisites failed', {
      missingVariables: missingVars,
      message: errorMsg,
    });
    throw new Error(errorMsg);
  }

  // Log authentication attempt with security measures
  const passwordPreview = adminPassword.substring(0, 5) + '***';
  logger.info('[AUTH] 🔐 Attempting PocketBase admin authentication', {
    email: adminEmail,
    passwordPreview: passwordPreview,
    pocketbaseUrl: process.env.POCKETBASE_URL,
  });

  // Check PocketBase health before auth attempt
  logger.info('[AUTH] Checking PocketBase health before authentication...');
  const isHealthy = await checkPocketBaseHealth();
  if (!isHealthy) {
    logger.error('[AUTH] ✗ PocketBase health check failed');
    throw new Error('PocketBase is not accessible or unhealthy');
  }
  logger.info('[AUTH] ✓ PocketBase health check passed');

  // APPROACH 1: Try admin_users collection endpoint
  logger.info('[AUTH] 📍 APPROACH 1: Attempting /api/collections/admin_users/auth-with-password');
  
  const error1 = await (async () => {
    try {
      const pbUrl = process.env.POCKETBASE_URL;
      const endpoint = `${pbUrl}/api/collections/admin_users/auth-with-password`;
      const requestBody = {
        identity: adminEmail,
        password: adminPassword,
      };

      logger.debug('[AUTH] Raw fetch request details (admin_users):', {
        endpoint: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: {
          identity: adminEmail,
          password: passwordPreview,
        },
      });

      logger.info('[AUTH] Sending authentication request to admin_users endpoint...');
      const fetchResponse = await withTimeout(
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(requestBody),
        }),
        OPERATION_TIMEOUT,
        'Admin authentication (admin_users)'
      );

      logger.debug('[AUTH] Raw fetch response received (admin_users):', {
        status: fetchResponse.status,
        statusText: fetchResponse.statusText,
        headers: Object.fromEntries(fetchResponse.headers.entries()),
      });

      // Check response.ok BEFORE reading the body to prevent double-reading
      if (!fetchResponse.ok) {
        const errorText = await fetchResponse.text();
        logger.warn('[AUTH] ⚠ APPROACH 1 returned error status', {
          status: fetchResponse.status,
          statusText: fetchResponse.statusText,
          responseBody: errorText,
          endpoint: endpoint,
        });
        return new Error(`HTTP ${fetchResponse.status}: ${errorText}`);
      }

      // Read body ONLY ONCE using response.json()
      const responseData = await fetchResponse.json();
      logger.debug('[AUTH] Raw fetch response body (admin_users):', responseData);

      logger.info('[AUTH] ✓ APPROACH 1 successful - admin_users authentication', {
        token: responseData.token ? `Token set (${responseData.token.substring(0, 20)}...)` : null,
        admin: responseData.record ? { id: responseData.record.id, email: responseData.record.email } : null,
      });

      // Store token in PocketBase authStore if successful
      if (responseData.token && responseData.record) {
        pb.authStore.save(responseData.token, responseData.record);
        logger.info('[AUTH] ✓ Token stored in PocketBase authStore');
        return null; // Success
      }

      return new Error('No token or admin data in response');
    } catch (error) {
      logger.warn('[AUTH] ✗ APPROACH 1 failed (admin_users)', {
        message: error.message,
        endpoint: `${process.env.POCKETBASE_URL}/api/collections/admin_users/auth-with-password`,
      });
      return error;
    }
  })();

  if (!error1) {
    logger.info('[AUTH] ✓ PocketBase authentication successful', {
      adminId: pb.authStore.record.id,
      adminEmail: pb.authStore.record.email,
    });
    return pb.authStore.record.id;
  }

  // APPROACH 2: Try users collection endpoint as fallback
  logger.info('[AUTH] 📍 APPROACH 2: Attempting /api/collections/users/auth-with-password (fallback)');
  
  const error2 = await (async () => {
    try {
      const pbUrl = process.env.POCKETBASE_URL;
      const endpoint = `${pbUrl}/api/collections/users/auth-with-password`;
      const requestBody = {
        identity: adminEmail,
        password: adminPassword,
      };

      logger.debug('[AUTH] Raw fetch request details (users):', {
        endpoint: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: {
          identity: adminEmail,
          password: passwordPreview,
        },
      });

      logger.info('[AUTH] Sending authentication request to users endpoint...');
      const fetchResponse = await withTimeout(
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(requestBody),
        }),
        OPERATION_TIMEOUT,
        'Admin authentication (users)'
      );

      logger.debug('[AUTH] Raw fetch response received (users):', {
        status: fetchResponse.status,
        statusText: fetchResponse.statusText,
        headers: Object.fromEntries(fetchResponse.headers.entries()),
      });

      // Check response.ok BEFORE reading the body
      if (!fetchResponse.ok) {
        const errorText = await fetchResponse.text();
        logger.warn('[AUTH] ⚠ APPROACH 2 returned error status', {
          status: fetchResponse.status,
          statusText: fetchResponse.statusText,
          responseBody: errorText,
          endpoint: endpoint,
        });
        return new Error(`HTTP ${fetchResponse.status}: ${errorText}`);
      }

      // Read body ONLY ONCE using response.json()
      const responseData = await fetchResponse.json();
      logger.debug('[AUTH] Raw fetch response body (users):', responseData);

      logger.info('[AUTH] ✓ APPROACH 2 successful - users collection authentication', {
        token: responseData.token ? `Token set (${responseData.token.substring(0, 20)}...)` : null,
        user: responseData.record ? { id: responseData.record.id, email: responseData.record.email } : null,
      });

      // Store token in PocketBase authStore if successful
      if (responseData.token && responseData.record) {
        pb.authStore.save(responseData.token, responseData.record);
        logger.info('[AUTH] ✓ Token stored in PocketBase authStore');
        return null; // Success
      }

      return new Error('No token or user data in response');
    } catch (error) {
      logger.error('[AUTH] ✗ APPROACH 2 failed (users collection)', {
        message: error.message,
        endpoint: `${process.env.POCKETBASE_URL}/api/collections/users/auth-with-password`,
      });
      return error;
    }
  })();

  if (!error2) {
    logger.info('[AUTH] ✓ PocketBase authentication successful', {
      adminId: pb.authStore.record.id,
      adminEmail: pb.authStore.record.email,
    });
    return pb.authStore.record.id;
  }

  // All approaches failed - throw comprehensive error
  const comprehensiveError = new Error(
    `PocketBase authentication failed - all approaches exhausted:\n` +
    `1. admin_users collection: ${error1.message}\n` +
    `2. users collection: ${error2.message}`
  );

  logger.error('[AUTH] ✗ PocketBase authentication failed - all approaches exhausted', {
    error1_adminUsers: error1.message,
    error2_users: error2.message,
    pocketbaseUrl: process.env.POCKETBASE_URL,
    adminEmail: adminEmail,
  });

  throw comprehensiveError;
};

// POST /qr/generate - Generate QR codes sequentially with duplicate handling
router.post('/generate', async (req, res) => {
  logger.info('Starting QR code generation...', { requestId: req.id });

  const { batch_name, total_codes, product_type, purity, weight, website, verification_url } = req.body;

  // Validate required fields
  if (!batch_name) {
    return res.status(400).json({ error: 'batch_name is required' });
  }
  if (!total_codes || typeof total_codes !== 'number' || total_codes <= 0) {
    return res.status(400).json({ error: 'total_codes must be a positive number' });
  }
  if (!product_type) {
    return res.status(400).json({ error: 'product_type is required' });
  }
  if (!purity) {
    return res.status(400).json({ error: 'purity is required' });
  }
  if (!weight) {
    return res.status(400).json({ error: 'weight is required' });
  }
  if (!website) {
    return res.status(400).json({ error: 'website is required' });
  }
  if (!verification_url) {
    return res.status(400).json({ error: 'verification_url is required' });
  }

  logger.debug('Batch creation request', {
    batch_name,
    total_codes,
    product_type,
    purity,
    weight,
    website,
    verification_url,
    requestId: req.id,
  });

  // Authenticate admin
  logger.info('[GENERATE] Authenticating admin before batch creation...', { requestId: req.id });
  const adminId = await authenticateAdmin();
  logger.info('[GENERATE] ✓ Admin authenticated successfully', {
    adminId: adminId,
    authStoreIsValid: pb.authStore.isValid,
    authStoreModel: pb.authStore.model ? { id: pb.authStore.model.id, email: pb.authStore.model.email } : null,
    requestId: req.id,
  });

  // Create batch record with ONLY the 4 fields that exist in qr_batches schema
  const batchPayload = {
    batch_name,
    total_codes,
    status: 'pending',
    created_by: adminId,
  };

  logger.info('📝 Preparing batch creation', {
    payload: batchPayload,
    adminId: adminId,
    collectionName: 'qr_batches',
    requestId: req.id,
  });

  let batch;
  try {
    logger.debug('Attempting to create batch record in PocketBase', {
      collection: 'qr_batches',
      payload: batchPayload,
      adminId: adminId,
      authStoreValid: pb.authStore.isValid,
      requestId: req.id,
    });

    batch = await withTimeout(
      pb.collection('qr_batches').create(batchPayload),
      OPERATION_TIMEOUT,
      'Create batch'
    );

    logger.info('✓ Batch created successfully', {
      batchId: batch.id,
      batchName: batch.batch_name,
      totalCodes: batch.total_codes,
      status: batch.status,
      requestId: req.id,
    });
  } catch (error) {
    // Comprehensive error logging for PocketBase validation errors
    logger.error('✗ Batch creation failed - DETAILED ERROR ANALYSIS', {
      errorMessage: error.message,
      errorStatus: error.status,
      errorCode: error.code,
      errorResponse: error.response,
      errorData: error.data,
      errorResponseData: error.response?.data,
      fullErrorObject: JSON.stringify(error, null, 2),
      payload: batchPayload,
      payloadKeys: Object.keys(batchPayload),
      adminId: adminId,
      authStoreValid: pb.authStore.isValid,
      authStoreModel: pb.authStore.model ? { id: pb.authStore.model.id, email: pb.authStore.model.email } : null,
      requestId: req.id,
    });

    // Also log to console for immediate visibility
    console.error('❌ BATCH CREATION ERROR - DETAILED ANALYSIS');
    console.error('Error Message:', error.message);
    console.error('Error Status:', error.status);
    console.error('Error Code:', error.code);
    console.error('Error Data:', error.data);
    console.error('Error Response Data:', error.response?.data);
    console.error('Full Error Object:', JSON.stringify(error, null, 2));
    console.error('Payload Sent:', JSON.stringify(batchPayload, null, 2));
    console.error('Payload Keys:', Object.keys(batchPayload));

    // Build detailed error message for client
    const validationErrors = error.data?.errors || error.response?.data?.errors || {};
    const validationErrorsString = Object.entries(validationErrors)
      .map(([field, fieldError]) => `${field}: ${JSON.stringify(fieldError)}`)
      .join('; ');

    const detailedErrorMessage = `Batch creation failed: ${error.message}. ` +
      `Status: ${error.status}. ` +
      `Validation errors: ${validationErrorsString || 'None'}. ` +
      `Response data: ${JSON.stringify(error.data || error.response?.data)}. ` +
      `Payload sent: ${JSON.stringify(batchPayload)}`;

    throw new Error(detailedErrorMessage);
  }

  const batchId = batch.id;
  const baseUrl = verification_url.endsWith('=') ? verification_url : `${verification_url}=`;

  logger.info(`Created batch ${batchId}, generating ${total_codes} QR codes sequentially...`, {
    requestId: req.id,
  });

  // Track creation and skipped counts
  let createdCount = 0;
  let skippedCount = 0;
  const details = [];

  // Generate QR codes sequentially (one at a time) with duplicate handling
  for (let i = 0; i < total_codes; i++) {
    const serialNumber = `Cu${String(i + 1).padStart(6, '0')}`;
    const qrUrl = `${baseUrl}${serialNumber}`;

    // Check if serial number already exists
    let serialExists = false;
    try {
      await withTimeout(
        pb.collection('qr_codes').getFirstListItem(`serial_number="${serialNumber}"`),
        OPERATION_TIMEOUT,
        `Check if serial ${serialNumber} exists`
      );
      serialExists = true;
    } catch (error) {
      // If error is 404 (not found), that's expected - serial doesn't exist
      if (error.status === 404) {
        serialExists = false;
      } else {
        // Re-throw other errors (connection issues, etc.)
        throw error;
      }
    }

    // If serial already exists, skip it
    if (serialExists) {
      logger.info(`⏭️  Skipping QR code ${i + 1} - serial number already exists: ${serialNumber}`, {
        requestId: req.id,
      });
      skippedCount++;
      details.push({
        serialNumber,
        status: 'skipped',
      });
      continue;
    }

    // Generate QR code as base64
    const qrImageUrl = await QRCode.toDataURL(qrUrl);

    // Create QR code record in database
    const qrPayload = {
      batch_id: batchId,
      serial_number: serialNumber,
      product_type,
      purity,
      weight,
      website,
      verification_url: qrUrl,
      qr_image_url: qrImageUrl,
    };

    logger.debug(`QR Code ${i + 1} payload prepared`, {
      serialNumber,
      payloadKeys: Object.keys(qrPayload),
      payloadSize: JSON.stringify(qrPayload).length,
      requestId: req.id,
    });

    logger.debug(`Attempting to create QR code ${i + 1} in PocketBase`, {
      collection: 'qr_codes',
      serialNumber,
      payloadKeys: Object.keys(qrPayload),
      authStoreValid: pb.authStore.isValid,
      requestId: req.id,
    });

    // Create QR code - let errorMiddleware handle errors
    await withTimeout(
      pb.collection('qr_codes').create(qrPayload),
      OPERATION_TIMEOUT,
      `Create QR code ${i + 1}`
    );

    createdCount++;
    details.push({
      serialNumber,
      status: 'created',
    });

    // Log progress after each code is saved
    const progressMessage = `✓ Created QR ${i + 1} of ${total_codes} (${serialNumber})`;
    console.log(progressMessage);
    logger.info(progressMessage, { requestId: req.id });
  }

  // Update batch status to completed
  await withTimeout(
    pb.collection('qr_batches').update(batchId, {
      status: 'completed',
    }),
    OPERATION_TIMEOUT,
    'Update batch status'
  );
  logger.info(`✓ Batch ${batchId} status updated to completed`, { requestId: req.id });

  logger.info(`✓ Batch ${batchId} completed - Created: ${createdCount}, Skipped: ${skippedCount}`, {
    requestId: req.id,
  });

  res.json({
    success: true,
    batchId,
    batchName: batch_name,
    total: total_codes,
    created: createdCount,
    skipped: skippedCount,
    status: 'completed',
    message: `Batch created successfully. Created: ${createdCount}, Skipped: ${skippedCount}`,
    details: details,
  });
});

// GET /qr/batches - Fetch all batches
router.get('/batches', async (req, res) => {
  logger.info('Fetching all QR batches...', { requestId: req.id });

  // Authenticate admin
  logger.info('[BATCHES] Authenticating admin before fetching batches...', { requestId: req.id });
  await authenticateAdmin();
  logger.info('[BATCHES] ✓ Admin authenticated successfully', { requestId: req.id });

  const data = await withTimeout(
    pb.collection('qr_batches').getList(1, 100, {
      sort: '-created_at',
    }),
    OPERATION_TIMEOUT,
    'Fetch batches list'
  );
  logger.info(`✓ Fetched ${data.items.length} batches`, { requestId: req.id });
  res.json(data.items);
});

// GET /qr/batch/:id - Fetch batch details
router.get('/batch/:id', async (req, res) => {
  const { id } = req.params;
  logger.info(`Fetching batch details for ID: ${id}`, { requestId: req.id });

  // Authenticate admin
  logger.info('[BATCH_DETAIL] Authenticating admin before fetching batch details...', { requestId: req.id });
  await authenticateAdmin();
  logger.info('[BATCH_DETAIL] ✓ Admin authenticated successfully', { requestId: req.id });

  const batch = await withTimeout(
    pb.collection('qr_batches').getOne(id),
    OPERATION_TIMEOUT,
    'Fetch batch details'
  );
  logger.info(`✓ Fetched batch ${id}`, { requestId: req.id });
  res.json(batch);
});

// POST /qr/export/:id - Export batch to Excel
router.post('/export/:id', async (req, res) => {
  const batchId = req.params.id;
  logger.info(`Exporting batch ${batchId} to Excel...`, { requestId: req.id });

  // Authenticate admin
  logger.info('[EXPORT] Authenticating admin before exporting batch...', { requestId: req.id });
  await authenticateAdmin();
  logger.info('[EXPORT] ✓ Admin authenticated successfully', { requestId: req.id });

  // Fetch batch
  const batch = await withTimeout(
    pb.collection('qr_batches').getOne(batchId),
    OPERATION_TIMEOUT,
    'Fetch batch for export'
  );
  logger.info(`✓ Fetched batch ${batchId}`, { requestId: req.id });

  // Fetch all QR codes for batch
  const qrCodesData = await withTimeout(
    pb.collection('qr_codes').getList(1, 3000, {
      filter: `batch_id="${batchId}"`,
    }),
    OPERATION_TIMEOUT,
    'Fetch QR codes for export'
  );

  const qrCodes = qrCodesData.items;
  logger.info(`✓ Fetched ${qrCodes.length} QR codes for batch ${batchId}`, { requestId: req.id });

  // Create workbook
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('QR Codes');

  // Add header row with styling
  const headerRow = worksheet.addRow([
    'Serial Number',
    'Product Type',
    'Purity',
    'Weight',
    'Website',
    'Verification URL',
    'QR Code Image',
  ]);

  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFB87333' }, // Copper color
  };
  headerRow.alignment = { horizontal: 'center', vertical: 'center' };

  // Add data rows
  for (const qrCode of qrCodes) {
    const row = worksheet.addRow([
      qrCode.serial_number,
      qrCode.product_type,
      qrCode.purity,
      qrCode.weight,
      qrCode.website,
      qrCode.verification_url,
      '', // Placeholder for image
    ]);

    // Embed QR code image if available
    if (qrCode.qr_image_url) {
      try {
        // Extract base64 data from data URL
        const base64Data = qrCode.qr_image_url.replace(
          /^data:image\/\w+;base64,/,
          ''
        );
        const imageId = workbook.addImage({
          buffer: Buffer.from(base64Data, 'base64'),
          extension: 'png',
        });

        worksheet.addImage(imageId, {
          tl: { col: 6, row: row.number - 1 },
          ext: { width: 100, height: 100 },
        });
      } catch (error) {
        logger.warn(`Failed to embed QR image for ${qrCode.serial_number}`, {
          message: error.message,
          requestId: req.id,
        });
      }
    }
  }

  // Set column widths
  worksheet.columns = [
    { width: 15 },
    { width: 15 },
    { width: 12 },
    { width: 12 },
    { width: 25 },
    { width: 35 },
    { width: 20 },
  ];

  // Generate Excel file
  const filename = `Cuprion_QR_Codes_Batch_${batchId}.xlsx`;
  const buffer = await workbook.xlsx.writeBuffer();

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"`
  );
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );

  logger.info(`✓ Exported batch ${batchId} with ${qrCodes.length} codes`, { requestId: req.id });

  res.send(buffer);
});

// DELETE /qr/batch/:id - Delete batch and associated QR codes
router.delete('/batch/:id', async (req, res) => {
  const batchId = req.params.id;
  logger.info(`Deleting batch ${batchId} and associated QR codes...`, { requestId: req.id });

  // Authenticate admin
  logger.info('[DELETE] Authenticating admin before deleting batch...', { requestId: req.id });
  await authenticateAdmin();
  logger.info('[DELETE] ✓ Admin authenticated successfully', { requestId: req.id });

  // Delete all QR codes for this batch
  const qrCodesData = await withTimeout(
    pb.collection('qr_codes').getList(1, 3000, {
      filter: `batch_id="${batchId}"`,
    }),
    OPERATION_TIMEOUT,
    'Fetch QR codes for deletion'
  );

  logger.info(`Found ${qrCodesData.items.length} QR codes to delete`, { requestId: req.id });

  for (const qrCode of qrCodesData.items) {
    await withTimeout(
      pb.collection('qr_codes').delete(qrCode.id),
      OPERATION_TIMEOUT,
      `Delete QR code ${qrCode.id}`
    );
  }

  logger.info(`✓ Deleted ${qrCodesData.items.length} QR codes`, { requestId: req.id });

  // Delete batch
  await withTimeout(
    pb.collection('qr_batches').delete(batchId),
    OPERATION_TIMEOUT,
    'Delete batch'
  );
  logger.info(`✓ Deleted batch ${batchId}`, { requestId: req.id });

  res.json({
    success: true,
    message: 'Batch deleted',
    deletedCodesCount: qrCodesData.items.length,
  });
});

// GET /qr/verify/:serial - Verify QR code by serial number
router.get('/verify/:serial', async (req, res) => {
  const serialNumber = req.params.serial;
  logger.info(`Verifying serial number: ${serialNumber}`, { requestId: req.id });

  const qrCode = await withTimeout(
    pb
      .collection('qr_codes')
      .getFirstListItem(`serial_number="${serialNumber}"`),
    OPERATION_TIMEOUT,
    'Verify QR code'
  ).catch((error) => {
    // If not found, return not authentic
    if (error.status === 404) {
      logger.warn(`QR code not found: ${serialNumber}`, { requestId: req.id });
      return null;
    }
    // Re-throw other errors
    throw error;
  });

  if (!qrCode) {
    return res.json({
      authentic: false,
      message: 'Product not found',
    });
  }

  logger.info(`✓ QR code verified: ${serialNumber}`, { requestId: req.id });

  res.json({
    authentic: true,
    serialNumber: qrCode.serial_number,
    productType: qrCode.product_type,
    purity: qrCode.purity,
    weight: qrCode.weight,
    website: qrCode.website,
    verificationUrl: qrCode.verification_url,
  });
});

// DEBUG ENDPOINT: GET /qr/debug/qr-schema - Inspect qr_batches collection schema
router.get('/debug/qr-schema', async (req, res) => {
  logger.info('🔍 DEBUG: Fetching qr_batches collection schema...', { requestId: req.id });
  
  const debugInfo = {
    timestamp: new Date().toISOString(),
    collectionName: 'qr_batches',
    schema: null,
    error: null,
  };

  try {
    // Authenticate admin first
    logger.info('[DEBUG_SCHEMA] Authenticating admin for schema inspection...', { requestId: req.id });
    await authenticateAdmin();
    logger.info('[DEBUG_SCHEMA] ✓ Admin authenticated successfully', { requestId: req.id });

    // Fetch the collection metadata
    const collection = await withTimeout(
      pb.collections.getOne('qr_batches'),
      OPERATION_TIMEOUT,
      'Fetch qr_batches collection schema'
    );

    logger.info('✓ Successfully fetched qr_batches collection schema', {
      collectionId: collection.id,
      collectionName: collection.name,
      fieldsCount: collection.schema?.length || 0,
      requestId: req.id,
    });

    // Extract field information
    const fields = collection.schema?.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required || false,
      options: field.options || {},
    })) || [];

    debugInfo.schema = {
      id: collection.id,
      name: collection.name,
      type: collection.type,
      system: collection.system,
      fields: fields,
      fieldNames: fields.map((f) => f.name),
      requiredFields: fields.filter((f) => f.required).map((f) => f.name),
    };

    logger.info('DEBUG: qr_batches schema details', {
      fieldCount: fields.length,
      fieldNames: fields.map((f) => f.name),
      requiredFields: fields.filter((f) => f.required).map((f) => f.name),
      requestId: req.id,
    });

    res.json({
      success: true,
      debug: debugInfo,
    });
  } catch (error) {
    logger.error('✗ Failed to fetch qr_batches schema', {
      errorMessage: error.message,
      errorStatus: error.status,
      errorData: error.data,
      requestId: req.id,
    });

    console.error('❌ SCHEMA FETCH ERROR');
    console.error('Error Message:', error.message);
    console.error('Error Status:', error.status);
    console.error('Error Data:', error.data);

    debugInfo.error = {
      message: error.message,
      status: error.status,
      data: error.data,
    };

    res.json({
      success: false,
      debug: debugInfo,
    });
  }
});

// DEBUG ENDPOINT: GET /qr/debug/auth - Test authentication with detailed logging
router.get('/debug/auth', async (req, res) => {
  logger.info('🔍 DEBUG: Testing PocketBase authentication...', { requestId: req.id });
  
  const debugInfo = {
    timestamp: new Date().toISOString(),
    environment: {
      POCKETBASE_URL: process.env.POCKETBASE_URL,
      POCKETBASE_ADMIN_EMAIL: process.env.POCKETBASE_ADMIN_EMAIL ? `${process.env.POCKETBASE_ADMIN_EMAIL.substring(0, 5)}***` : 'NOT SET',
      POCKETBASE_ADMIN_PASSWORD: process.env.POCKETBASE_ADMIN_PASSWORD ? 'SET' : 'NOT SET',
      NODE_ENV: process.env.NODE_ENV,
    },
    authAttempts: [],
  };

  // Test 1: Health check
  logger.info('DEBUG: Test 1 - Health check', { requestId: req.id });
  const healthCheckResult = await (async () => {
    try {
      const health = await withTimeout(
        pb.health.check(),
        OPERATION_TIMEOUT,
        'Debug health check'
      );
      debugInfo.authAttempts.push({
        test: 'Health Check',
        status: 'success',
        result: { code: health.code, message: health.message },
      });
      logger.info('✓ DEBUG: Health check passed', { requestId: req.id });
      return true;
    } catch (error) {
      debugInfo.authAttempts.push({
        test: 'Health Check',
        status: 'failed',
        error: error.message,
      });
      logger.error('✗ DEBUG: Health check failed', { error: error.message, requestId: req.id });
      return false;
    }
  })();

  // Test 2: admin_users collection auth
  logger.info('DEBUG: Test 2 - admin_users collection authentication', { requestId: req.id });
  await (async () => {
    try {
      const adminEmail = process.env.POCKETBASE_ADMIN_EMAIL;
      const adminPassword = process.env.POCKETBASE_ADMIN_PASSWORD;
      const pbUrl = process.env.POCKETBASE_URL;
      
      if (!adminEmail || !adminPassword) {
        throw new Error('Missing admin credentials');
      }

      const endpoint = `${pbUrl}/api/collections/admin_users/auth-with-password`;
      const fetchResponse = await withTimeout(
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            identity: adminEmail,
            password: adminPassword,
          }),
        }),
        OPERATION_TIMEOUT,
        'Debug admin_users auth'
      );

      let responseData;
      if (!fetchResponse.ok) {
        responseData = await fetchResponse.text();
      } else {
        responseData = await fetchResponse.json();
      }

      debugInfo.authAttempts.push({
        test: 'admin_users Collection Auth',
        status: fetchResponse.ok ? 'success' : 'failed',
        result: {
          statusCode: fetchResponse.status,
          statusText: fetchResponse.statusText,
          endpoint: endpoint,
          responseBody: responseData,
        },
      });
      logger.info('DEBUG: admin_users auth completed', { status: fetchResponse.status, requestId: req.id });
    } catch (error) {
      debugInfo.authAttempts.push({
        test: 'admin_users Collection Auth',
        status: 'failed',
        error: error.message,
      });
      logger.error('✗ DEBUG: admin_users auth failed', { error: error.message, requestId: req.id });
    }
  })();

  // Test 3: users collection auth
  logger.info('DEBUG: Test 3 - users collection authentication', { requestId: req.id });
  await (async () => {
    try {
      const adminEmail = process.env.POCKETBASE_ADMIN_EMAIL;
      const adminPassword = process.env.POCKETBASE_ADMIN_PASSWORD;
      const pbUrl = process.env.POCKETBASE_URL;
      
      if (!adminEmail || !adminPassword) {
        throw new Error('Missing admin credentials');
      }

      const endpoint = `${pbUrl}/api/collections/users/auth-with-password`;
      const fetchResponse = await withTimeout(
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            identity: adminEmail,
            password: adminPassword,
          }),
        }),
        OPERATION_TIMEOUT,
        'Debug users auth'
      );

      let responseData;
      if (!fetchResponse.ok) {
        responseData = await fetchResponse.text();
      } else {
        responseData = await fetchResponse.json();
      }

      debugInfo.authAttempts.push({
        test: 'users Collection Auth',
        status: fetchResponse.ok ? 'success' : 'failed',
        result: {
          statusCode: fetchResponse.status,
          statusText: fetchResponse.statusText,
          endpoint: endpoint,
          responseBody: responseData,
        },
      });
      logger.info('DEBUG: users auth completed', { status: fetchResponse.status, requestId: req.id });
    } catch (error) {
      debugInfo.authAttempts.push({
        test: 'users Collection Auth',
        status: 'failed',
        error: error.message,
      });
      logger.error('✗ DEBUG: users auth failed', { error: error.message, requestId: req.id });
    }
  })();

  res.json({
    success: healthCheckResult,
    debug: debugInfo,
  });
});

export default router;