/**
 * Wraps a promise with a timeout using AbortController.
 * Rejects if the promise doesn't resolve within the specified time.
 * @param {Promise} promise - The promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} operationName - Name of the operation for error messages
 * @returns {Promise} - The original promise or a rejection if timeout is exceeded
 */
export function withTimeout(promise, timeoutMs = 120000, operationName = 'Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ]);
}

/**
 * Retry logic with exponential backoff for failed operations
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} initialDelayMs - Initial delay in milliseconds
 * @param {string} operationName - Name of the operation for logging
 * @returns {Promise} - Result of the function
 */
export async function withRetry(fn, maxRetries = 3, initialDelayMs = 1000, operationName = 'Operation') {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries) {
        const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
        console.warn(`${operationName} attempt ${attempt} failed, retrying in ${delayMs}ms...`, error.message);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  throw new Error(`${operationName} failed after ${maxRetries} attempts: ${lastError.message}`);
}