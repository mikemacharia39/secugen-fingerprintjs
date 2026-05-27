/**
 * SecuGen HU20 WebUSB driver.
 *
 * All USB request codes and parameter values were reverse-engineered from
 * USBPcap/Wireshark captures of the official SecuGen SDK communicating with
 * the device. Nothing here comes from official documentation.
 *
 * Windows note: WebUSB requires the WinUSB kernel driver to be bound to this
 * device. If SecuGen's SDK driver is installed, use Zadig to rebind first.
 */

const VENDOR_ID = 0x1162;
const IMAGE_WIDTH = 300;
const IMAGE_HEIGHT = 400;
// The device sends 1307 × 512-byte USB bulk packets per transfer.
// The first IMAGE_WIDTH * IMAGE_HEIGHT bytes are the greyscale image pixels.
const BULK_TRANSFER_SIZE = 669184;
const IMAGE_PIXEL_COUNT = IMAGE_WIDTH * IMAGE_HEIGHT;

export class SecuGenScanner extends EventTarget {
    #device = null;

    get connected() {
        return this.#device !== null && this.#device.opened;
    }

    get deviceName() {
        return this.#device?.productName ?? null;
    }

    /**
     * Check if a previously-paired SecuGen device is already available
     * (no user gesture required). Returns true if one is found and claimed.
     */
    async autoConnect() {
        const devices = await navigator.usb.getDevices();
        const secugen = devices.find(d => d.vendorId === VENDOR_ID);
        if (!secugen) return false;
        await this.#open(secugen);
        return true;
    }

    /**
     * Show the browser's device picker and connect to the chosen device.
     * Must be called from a user gesture (button click).
     */
    async requestConnect() {
        const device = await navigator.usb.requestDevice({ filters: [{ vendorId: VENDOR_ID }] });
        await this.#open(device);
    }

    /**
     * Issue a USB bus reset on the device before claiming the interface.
     *
     * This is the software equivalent of physically unplugging and replugging:
     * Windows re-enumerates the device and releases all existing kernel-level
     * handles from other processes (stale browser sessions, SecuGen SDK processes,
     * Windows Biometric Framework residuals). Use this when requestConnect() fails
     * with "Unable to claim interface" even after the WinUSB driver is active.
     */
    async forceConnect() {
        const device = await navigator.usb.requestDevice({ filters: [{ vendorId: VENDOR_ID }] });
        this.dispatchEvent(new CustomEvent('log', { detail: 'Force connect: opening device for USB reset…' }));
        await device.open();
        this.dispatchEvent(new CustomEvent('log', { detail: 'Sending USB reset — forces all other applications to release the device…' }));
        await device.reset();
        this.dispatchEvent(new CustomEvent('log', { detail: 'Waiting for device to re-enumerate…' }));
        await new Promise(resolve => setTimeout(resolve, 1500));
        const devices = await navigator.usb.getDevices();
        const fresh = devices.find(d => d.vendorId === VENDOR_ID);
        if (!fresh) throw new Error('Device did not re-enumerate after reset. Unplug and replug the scanner.');
        this.dispatchEvent(new CustomEvent('log', { detail: 'Device re-enumerated — claiming interface…' }));
        await this.#open(fresh);
    }

    async disconnect() {
        if (!this.#device) return;
        try {
            await this.#device.releaseInterface(0);
            await this.#device.close();
        } finally {
            this.#device = null;
            this.dispatchEvent(new Event('disconnect'));
        }
    }

    /**
     * Run the full capture sequence:
     *   1. Initialize device registers (from USB packet capture)
     *   2. Arm capture (request 1)
     *   3. Read first bulk transfer (pre-capture frame, discarded)
     *   4. Turn on LED, configure live-view registers
     *   5. Arm capture again
     *   6. Read second bulk transfer — this is the fingerprint image
     *
     * Returns an ImageData (300×400, greyscale) ready for putImageData().
     */
    async capture() {
        this.#assertConnected();
        await this.#initialize();
        await this.#armCapture();
        await this.#bulkRead(); // discard pre-capture frame
        await this.#setupLiveCapture();
        await this.#armCapture();
        const raw = await this.#bulkRead();
        return this.#decodeImage(raw);
    }

    /**
     * Turn the LED on or off. Device must be connected first.
     */
    async setLED(on) {
        this.#assertConnected();
        await this.#controlOut(17, on ? 0x1 : 0x0, 0x0);
    }

    /**
     * Read the raw 669,184-byte bulk transfer and return it as a Uint8Array.
     * Useful for debugging the data format without rendering.
     */
    async rawCapture() {
        this.#assertConnected();
        await this.#initialize();
        await this.#armCapture();
        return this.#bulkRead();
    }

    // -------------------------------------------------------------------------
    // Private: device lifecycle
    // -------------------------------------------------------------------------

    async #open(device) {
        this.dispatchEvent(new CustomEvent('log', { detail: `Device: ${device.productName} (VID 0x${device.vendorId.toString(16)}, PID 0x${device.productId.toString(16)})` }));

        await device.open();
        this.dispatchEvent(new CustomEvent('log', { detail: `device.open() OK` }));

        // Log all configurations and interfaces so driver issues are visible in the debug log.
        for (const config of device.configurations) {
            this.dispatchEvent(new CustomEvent('log', { detail: `Config ${config.configurationValue}: ${config.interfaces.length} interface(s)` }));
            for (const iface of config.interfaces) {
                const alt = iface.alternates[0];
                this.dispatchEvent(new CustomEvent('log', { detail: `  Interface ${iface.interfaceNumber}: class 0x${alt?.interfaceClass?.toString(16) ?? '?'}, claimed=${iface.claimed}` }));
            }
        }

        await device.selectConfiguration(1);
        this.dispatchEvent(new CustomEvent('log', { detail: `selectConfiguration(1) OK` }));

        try {
            await device.claimInterface(0);
        } catch (e) {
            throw new Error(
                'Unable to claim interface — another application holds the USB device. ' +
                'Use "Force Connect" to issue a USB reset and clear existing claims.'
            );
        }
        this.dispatchEvent(new CustomEvent('log', { detail: `claimInterface(0) OK — device ready` }));

        this.#device = device;
        this.dispatchEvent(new Event('connect'));
    }

    #assertConnected() {
        if (!this.connected) throw new Error('Scanner not connected');
    }

    // -------------------------------------------------------------------------
    // Private: USB primitives
    // -------------------------------------------------------------------------

    async #controlOut(request, value, index, data) {
        const setup = { requestType: 'vendor', recipient: 'device', request, value, index };
        if (data) {
            await this.#device.controlTransferOut(setup, data);
        } else {
            await this.#device.controlTransferOut(setup);
        }
    }

    async #controlIn(request, value, index, length) {
        const result = await this.#device.controlTransferIn(
            { requestType: 'vendor', recipient: 'device', request, value, index },
            length
        );
        return result.data;
    }

    /** Write a single-byte register, then read it back to confirm. */
    async #setParam(index, value) {
        const data = new Int8Array([value]);
        await this.#device.controlTransferOut(
            { requestType: 'vendor', recipient: 'device', request: 34, value: 0x37, index },
            data
        );
        await this.#controlIn(34, 0x37, index, 1);
    }

    async #pollStatus() {
        await this.#controlIn(37, 0, 0, 30);
    }

    async #flush() {
        await this.#controlOut(5, 0x1, 0x0);
    }

    async #controlQuad(request, b1, b2, b3, b4) {
        await this.#controlOut(request, 0x0, 0x0, new Int8Array([b1, b2, b3, b4]));
    }

    async #armCapture() {
        await this.#controlOut(1, 0x0, 0x0);
    }

    async #stopCapture() {
        await this.#controlOut(2, 0x0, 0x0);
    }

    async #bulkRead() {
        const result = await this.#device.transferIn(2, BULK_TRANSFER_SIZE);
        return new Uint8Array(result.data.buffer);
    }

    // -------------------------------------------------------------------------
    // Private: initialization sequence (from USB packet capture)
    // -------------------------------------------------------------------------

    async #initialize() {
        await this.#pollStatus();
        await this.#pollStatus();
        await this.#pollStatus();

        // Core sensor parameters
        await this.#setParam(0x03, 0x02);
        await this.#setParam(0x04, 0x81);
        await this.#setParam(0x05, 0x0a);
        await this.#setParam(0x08, 0x00);
        await this.#setParam(0x09, 0x11);
        await this.#setParam(0x0a, 0x11);
        await this.#setParam(0x10, 0x11);
        await this.#setParam(0x11, 0x23);
        await this.#setParam(0x12, 0x85);
        await this.#setParam(0x13, 0x00);
        await this.#setParam(0x14, 0x27);
        await this.#setParam(0x16, 0xb6);

        // Timing / clock
        await this.#setParam(0x30, 0x01);
        await this.#setParam(0x31, 0xc0);
        await this.#setParam(0x32, 0x08);

        // Image window — first pass
        await this.#setParam(0x41, 0x00);
        await this.#setParam(0x42, 0x00);
        await this.#setParam(0x43, 0x06);
        await this.#setParam(0x44, 0x43);
        await this.#setParam(0x45, 0x00);
        await this.#setParam(0x46, 0x00);
        await this.#setParam(0x47, 0x04);
        await this.#setParam(0x48, 0xb3);
        await this.#setParam(0x49, 0x00);
        await this.#setParam(0x4a, 0x20);
        await this.#setParam(0x4b, 0x00);
        await this.#setParam(0x4c, 0x00);
        await this.#setParam(0x4d, 0x00);
        await this.#setParam(0x4e, 0x00);

        // Gain / exposure
        await this.#setParam(0x60, 0x0b);
        await this.#setParam(0x61, 0x16);
        await this.#setParam(0x62, 0x32);
        await this.#setParam(0x63, 0x80);
        await this.#setParam(0x71, 0x08);
        await this.#setParam(0x80, 0xf8);
        await this.#setParam(0x81, 0x06);

        // Auto-exposure control
        await this.#setParam(0x90, 0xaa);
        await this.#setParam(0x91, 0x08);
        await this.#setParam(0x92, 0x10);
        await this.#setParam(0x93, 0x40);
        await this.#setParam(0x94, 0x04);
        await this.#setParam(0x95, 0x01);
        await this.#setParam(0x96, 0x02);
        await this.#setParam(0x97, 0x80);
        await this.#setParam(0x98, 0x10);
        await this.#setParam(0x99, 0x08);
        await this.#setParam(0x9a, 0x03);
        await this.#setParam(0x9b, 0xb0);
        await this.#setParam(0x9c, 0x08);
        await this.#setParam(0x9d, 0x24);
        await this.#setParam(0x93, 0x30);

        // Binarization thresholds
        await this.#setParam(0xb7, 0x15);
        await this.#setParam(0xb8, 0x28);
        await this.#setParam(0xb9, 0x04);

        await this.#setParam(0x03, 0x05);

        // Offsets
        await this.#setParam(0xa5, 0x00);
        await this.#setParam(0xa6, 0x00);
        await this.#setParam(0xa7, 0x00);
        await this.#setParam(0xa8, 0x00);

        // Image window — calibration capture
        await this.#setParam(0x41, 0x00);
        await this.#setParam(0x42, 0xfa);
        await this.#setParam(0x43, 0x0a);
        await this.#setParam(0x44, 0x4f);
        await this.#setParam(0x45, 0x00);
        await this.#setParam(0x46, 0x28);
        await this.#setParam(0x47, 0x03);
        await this.#setParam(0x48, 0x23);
        await this.#flush();

        await this.#controlIn(8, 0x0, 0x2000, 2);

        // Image window — live capture
        await this.#setParam(0x41, 0x01);
        await this.#setParam(0x42, 0x4c);
        await this.#setParam(0x43, 0x03);
        await this.#setParam(0x44, 0xc7);
        await this.#setParam(0x45, 0x00);
        await this.#setParam(0x46, 0xac);
        await this.#setParam(0x47, 0x02);
        await this.#setParam(0x48, 0xb9);
        await this.#flush();

        await this.#controlQuad(64, 0x3, 0xe8, 0x00, 0x00);
        await this.#flush();
    }

    async #setupLiveCapture() {
        await this.#stopCapture();
        await this.#controlQuad(65, 0x00, 0x00, 0x00, 0x00);
        await this.#controlQuad(64, 0x05, 0x82, 0x00, 0x00);
        await this.#controlQuad(65, 0x00, 0x00, 0x00, 0x00);

        await this.#setParam(0x30, 0x05);
        await this.#setParam(0x31, 0x82);
        await this.#setParam(0x32, 0x00);

        await this.#controlOut(17, 0x1, 0x0); // LED on
        await this.#controlIn(22, 0x0, 0x2000, 4);
        await this.#controlIn(22, 0x0, 0x2000, 4);
        await this.#controlOut(17, 0x1, 0x0);
        await this.#controlQuad(65, 0x00, 0x00, 0x00, 0x00);
        await this.#controlQuad(64, 0x05, 0x82, 0x00, 0x00);
        await this.#flush();
    }

    // -------------------------------------------------------------------------
    // Private: image decoding
    // -------------------------------------------------------------------------

    /**
     * Convert the raw bulk transfer bytes into an ImageData.
     *
     * The transfer contains 1307 × 512-byte USB bulk packets. The sensor
     * writes greyscale pixel rows starting at byte 0. Pixels beyond
     * IMAGE_PIXEL_COUNT are framing overhead and are discarded.
     *
     * If the image looks wrong (all black, or noise), try non-zero offsets
     * and check the browser console for the raw hex dump via rawCapture().
     */
    #decodeImage(raw) {
        const imageData = new ImageData(IMAGE_WIDTH, IMAGE_HEIGHT);
        for (let i = 0; i < IMAGE_PIXEL_COUNT; i++) {
            const px = raw[i];
            imageData.data[i * 4 + 0] = px;
            imageData.data[i * 4 + 1] = px;
            imageData.data[i * 4 + 2] = px;
            imageData.data[i * 4 + 3] = 255;
        }
        return imageData;
    }
}
