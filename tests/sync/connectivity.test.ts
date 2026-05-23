import { setupConnectivityListeners } from '@/sync/connectivity';

describe('setupConnectivityListeners', () => {
	let originalNavigator: PropertyDescriptor | undefined;
	let originalAddEventListener: typeof window.addEventListener;
	let originalRemoveEventListener: typeof window.removeEventListener;
	let listeners: Array<{ event: string; handler: EventListener }>;

	beforeEach(() => {
		listeners = [];
		originalAddEventListener = window.addEventListener.bind(window);
		originalRemoveEventListener = window.removeEventListener.bind(window);

		// Capture registrations
		window.addEventListener = jest.fn((event: string, handler: EventListenerOrEventListenerObject) => {
			listeners.push({ event, handler: handler as EventListener });
		}) as unknown as typeof window.addEventListener;

		window.removeEventListener = jest.fn((event: string, handler: EventListenerOrEventListenerObject) => {
			listeners = listeners.filter(
				(l) => !(l.event === event && l.handler === handler)
			);
		}) as unknown as typeof window.removeEventListener;

		originalNavigator = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
		Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
	});

	afterEach(() => {
		window.addEventListener = originalAddEventListener;
		window.removeEventListener = originalRemoveEventListener;
		if (originalNavigator) {
			Object.defineProperty(window.navigator, 'onLine', originalNavigator);
		}
	});

	it('registers online + offline listeners', () => {
		const onOnline = jest.fn();
		const onOffline = jest.fn();
		setupConnectivityListeners(onOnline, onOffline);

		const events = listeners.map((l) => l.event).sort();
		expect(events).toEqual(['offline', 'online']);
	});

	it('fires onOnline when the online listener is invoked', () => {
		const onOnline = jest.fn();
		const onOffline = jest.fn();
		setupConnectivityListeners(onOnline, onOffline);

		const online = listeners.find((l) => l.event === 'online')!.handler;
		online(new Event('online'));
		expect(onOnline).toHaveBeenCalledTimes(1);
		expect(onOffline).not.toHaveBeenCalled();
	});

	it('fires onOffline when the offline listener is invoked', () => {
		const onOnline = jest.fn();
		const onOffline = jest.fn();
		setupConnectivityListeners(onOnline, onOffline);

		const offline = listeners.find((l) => l.event === 'offline')!.handler;
		offline(new Event('offline'));
		expect(onOffline).toHaveBeenCalledTimes(1);
	});

	it('fires onOffline immediately when navigator.onLine is false at setup', () => {
		Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
		const onOnline = jest.fn();
		const onOffline = jest.fn();
		setupConnectivityListeners(onOnline, onOffline);
		expect(onOffline).toHaveBeenCalledTimes(1);
	});

	it('returns a cleanup function that removes both listeners', () => {
		const cleanup = setupConnectivityListeners(jest.fn(), jest.fn());
		expect(listeners).toHaveLength(2);
		cleanup();
		expect(listeners).toHaveLength(0);
	});
});
