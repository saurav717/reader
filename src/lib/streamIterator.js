/**
 * `for await (const chunk of stream)` on a ReadableStream, for the browsers
 * that do not have it — Safari among them. pdf.js reads a page's text that
 * way, and without this every PDF fails in Safari with "undefined is not a
 * function (near '…n of t…')", so Reflow falls back to the HTML rendering.
 */
export function polyfillStreamIterator() {
    if (typeof ReadableStream === 'undefined')
        return;
    const proto = ReadableStream.prototype;
    if (typeof proto[Symbol.asyncIterator] === 'function')
        return;
    function values(options) {
        const reader = this.getReader();
        const preventCancel = Boolean(options?.preventCancel);
        return {
            async next() {
                try {
                    const result = await reader.read();
                    if (result.done)
                        reader.releaseLock();
                    return result;
                }
                catch (error) {
                    reader.releaseLock();
                    throw error;
                }
            },
            async return(value) {
                if (preventCancel)
                    reader.releaseLock();
                else {
                    const cancelled = reader.cancel(value);
                    reader.releaseLock();
                    await cancelled;
                }
                return { done: true, value };
            },
            [Symbol.asyncIterator]() {
                return this;
            },
        };
    }
    Object.defineProperty(proto, 'values', { value: values, writable: true, configurable: true });
    Object.defineProperty(proto, Symbol.asyncIterator, { value: values, writable: true, configurable: true });
}
polyfillStreamIterator();
