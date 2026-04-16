import en from './en.js';
import ru from './ru.js';

const languages = { en, ru };

/**
 * Get translation object for a given language code.
 * Falls back to English if language not found.
 */
export function getTranslations(lang = 'en') {
  return languages[lang] || languages.en;
}

/**
 * Get a specific translation key, with fallback to English.
 */
export function t(lang, key, ...args) {
  const translations = languages[lang] || languages.en;
  const value = translations[key] ?? languages.en[key];
  if (typeof value === 'function') return value(...args);
  return value ?? key;
}

export { en, ru };
export default { getTranslations, t, en, ru };
