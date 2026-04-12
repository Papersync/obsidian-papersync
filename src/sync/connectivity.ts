import { isOnline } from '@/utils/platform';
import { logger } from '@/utils/logger';

export function setupConnectivityListeners(
	onOnline: () => void,
	onOffline: () => void
): () => void {
	const handleOnline = (): void => {
		logger.info('Network connectivity restored');
		onOnline();
	};

	const handleOffline = (): void => {
		logger.info('Network connectivity lost');
		onOffline();
	};

	window.addEventListener('online', handleOnline);
	window.addEventListener('offline', handleOffline);

	if (!isOnline()) {
		onOffline();
	}

	return () => {
		window.removeEventListener('online', handleOnline);
		window.removeEventListener('offline', handleOffline);
	};
}
