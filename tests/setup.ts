import { TextEncoder, TextDecoder } from 'util';
import { webcrypto } from 'crypto';

// jsdom doesn't include TextEncoder/TextDecoder
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as typeof global.TextDecoder;

// jsdom doesn't include crypto.subtle
Object.defineProperty(global, 'crypto', {
	value: webcrypto,
});
