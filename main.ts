//% color=#0fbc11 icon=""
namespace nrf24 {
    // Default pins (change with init block)
    let csPin: DigitalPin = DigitalPin.P16
    let cePin: DigitalPin = DigitalPin.P8
    let inited = false
    let rxHandler: ((msg: string) => void) | null = null

    // nRF24 commands
    const R_REGISTER = 0x00
    const W_REGISTER = 0x20
    const R_RX_PAYLOAD = 0x61
    const W_TX_PAYLOAD = 0xA0
    const FLUSH_TX = 0xE1
    const FLUSH_RX = 0xE2
    const NOP = 0xFF

    // registers
    const CONFIG = 0x00
    const STATUS = 0x07
    const RX_PW_P0 = 0x11
    const RF_CH = 0x05
    const RF_SETUP = 0x06
    const TX_ADDR = 0x10
    const RX_ADDR_P0 = 0x0A

    function csLow() { pins.digitalWritePin(csPin, 0) }
    function csHigh() { pins.digitalWritePin(csPin, 1) }
    function ceLow() { pins.digitalWritePin(cePin, 0) }
    function ceHigh() { pins.digitalWritePin(cePin, 1) }

    function spiInit() {
        // MOSI = P15, MISO = P14, SCK = P13 (default)
        pins.spiPins(DigitalPin.P15, DigitalPin.P14, DigitalPin.P13)
        // 8 bits per transfer, mode 0
        pins.spiFormat(8, 0)
        // 1 MHz
        pins.spiFrequency(1000000)
    }

    function spiTransfer(val: number): number {
        return pins.spiWrite(val)
    }

    function writeRegister(reg: number, value: number) {
        csLow()
        spiTransfer(W_REGISTER | (reg & 0x1F))
        spiTransfer(value)
        csHigh()
    }

    function readRegister(reg: number): number {
        csLow()
        spiTransfer(R_REGISTER | (reg & 0x1F))
        const v = spiTransfer(0x00)
        csHigh()
        return v
    }

    function writeRegisterMulti(reg: number, data: number[]) {
        csLow()
        spiTransfer(W_REGISTER | (reg & 0x1F))
        for (let i = 0; i < data.length; i++) spiTransfer(data[i])
        csHigh()
    }

    function readPayload(len: number): number[] {
        const out: number[] = []
        csLow()
        spiTransfer(R_RX_PAYLOAD)
        for (let i = 0; i < len; i++) out.push(spiTransfer(0x00))
        csHigh()
        return out
    }

    function writePayload(data: number[]) {
        csLow()
        spiTransfer(W_TX_PAYLOAD)
        for (let i = 0; i < data.length; i++) spiTransfer(data[i])
        csHigh()
    }

    function flushTX() {
        csLow(); spiTransfer(FLUSH_TX); csHigh()
    }
    function flushRX() {
        csLow(); spiTransfer(FLUSH_RX); csHigh()
    }

    function clearIRQ(rx: boolean = true, tx: boolean = true, maxrt: boolean = true) {
        // STATUS: bit6 RX_DR, bit5 TX_DS, bit4 MAX_RT
        let mask = 0
        if (rx) mask |= (1 << 6)
        if (tx) mask |= (1 << 5)
        if (maxrt) mask |= (1 << 4)
        writeRegister(STATUS, mask)
    }

    function toStringTrim(buf: number[]): string {
        // convert bytes (assumes ASCII) and trim trailing 0
        let s = ""
        for (let b of buf) {
            if (b == 0) break
            s += String.fromCharCode(b)
        }
        return s
    }

    //% blockId="nrf_init" block="nRF24 init CS %cs CE %ce channel %chan"
    //% cs.defl=DigitalPin.P16 ce.defl=DigitalPin.P8 chan.min=0 chan.max=125
    export function init(cs: DigitalPin, ce: DigitalPin, chan: number = 76) {
        csPin = cs
        cePin = ce
        pins.digitalWritePin(csPin, 1)
        pins.digitalWritePin(cePin, 0)
        spiInit()
        pins.digitalWritePin(csPin, 1)
        // Basic config: enable CRC (2 bytes), PWR_UP=1, PRIM_RX=1 (RX mode)
        // 0x0B = (EN_CRC=1 <<3) | (CRCO=1 <<2) | (PWR_UP=1 <<1) | (PRIM_RX=1 <<0)
        writeRegister(CONFIG, 0x0B)
        // Set RF channel
        writeRegister(RF_CH, chan & 0x7F)
        // RF setup: 2Mbps, 0dBm (0x07 is a common working value)
        writeRegister(RF_SETUP, 0x07)
        // Set RX payload width for pipe0 to 32 bytes
        writeRegister(RX_PW_P0, 32)
        // Default 5-byte address example (must match on other node)
        const addr = [0xE7, 0xE7, 0xE7, 0xE7, 0xE7]
        writeRegisterMulti(RX_ADDR_P0, addr)
        writeRegisterMulti(TX_ADDR, addr)
        flushRX()
        flushTX()
        clearIRQ()
        // Enter RX mode: set CE high after small delay
        basic.pause(2)
        ceHigh()
        basic.pause(2)
        inited = true

        // start background receive polling
        control.inBackground(() => {
            while (true) {
                if (!inited) { basic.pause(50); continue }
                // Read STATUS via NOP (returns STATUS)
                const status = spiTransfer(NOP)
                // RX_DR?
                if ((status & (1 << 6)) != 0) {
                    // read 32 bytes (RX_PW_P0 set to 32)
                    const payload = readPayload(32)
                    // clear RX_DR
                    clearIRQ(true, false, false)
                    // call handler if exists
                    if (rxHandler) rxHandler(toStringTrim(payload))
                }
                basic.pause(20)
            }
        })
    }

    //% blockId="nrf_send" block="nRF24 send text %txt"
    export function sendText(txt: string) {
        if (!inited) return
        // prepare 32-byte buffer (pad with 0)
        const buf: number[] = []
        for (let i = 0; i < 32; i++) {
            if (i < txt.length) {
                buf.push(txt.charCodeAt(i))
            } else {
                buf.push(0)
            }
        }
        // switch to TX mode: set PRIM_RX=0, PWR_UP=1 -> CONFIG = 0x0A
        writeRegister(CONFIG, 0x0A)
        flushTX()
        writePayload(buf)
        // pulse CE >10us to start TX
        ceHigh()
        control.waitMicros(20)
        ceLow()
        // wait small time, then restore PRX (RX mode)
        basic.pause(2)
        // back to RX mode
        writeRegister(CONFIG, 0x0B)
        basic.pause(2)
        ceHigh()
    }

    //% blockId="nrf_onreceived" block="on nRF24 received %handler"
    export function onReceived(handler: (msg: string) => void) {
        rxHandler = handler
    }
}
