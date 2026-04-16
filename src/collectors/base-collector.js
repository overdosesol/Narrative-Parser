/**
 * Base collector class — defines the interface for all platform collectors
 */
class BaseCollector {
  constructor(name, logger) {
    this.name = name;
    this.logger = logger;
  }

  /**
   * Collect trending items from the platform
   * @returns {Promise<Array<{externalId, source, title, description, url, metrics}>>}
   */
  async collect() {
    throw new Error(`${this.name}: collect() not implemented`);
  }

  /**
   * Normalize raw platform data into unified format
   */
  normalize(rawItem) {
    throw new Error(`${this.name}: normalize() not implemented`);
  }

  /**
   * Safe wrapper around collect with error handling
   */
  async safeCollect() {
    try {
      this.logger.info(`[${this.name}] Starting collection...`);
      const items = await this.collect();
      this.logger.info(`[${this.name}] Collected ${items.length} items`);
      return items;
    } catch (error) {
      this.logger.error(`[${this.name}] Collection failed: ${error.message}`);
      return [];
    }
  }
}

export default BaseCollector;
