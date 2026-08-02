import { getRequestConfig } from 'next-intl/server';
import messages from '../../messages/en.json';

/** App UI is English-only. */
export default getRequestConfig(async () => ({
  locale: 'en',
  messages,
}));
