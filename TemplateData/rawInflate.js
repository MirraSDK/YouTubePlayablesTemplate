// Decodes raw DEFLATE data (RFC 1951) for browsers without DecompressionStream("deflate-raw").
// It ships with the page because YouTube Playables forbids requests to outside domains.
(function () {
    "use strict";

    const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const lengthExtraBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const distanceBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const distanceExtraBits = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    const codeLengthOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

    const maximumBits = 15;
    const fastBits = 9;
    const fastMask = (1 << fastBits) - 1;

    let fixedTables = null;

    // A canonical Huffman table: symbol counts per code length, symbols in code order, and a lookup of short codes
    // by their next input bits (symbol << 4 | length, zero when the code is longer).
    function createTable(lengths, offset, count) {
        const counts = new Uint16Array(maximumBits + 1);
        for (let index = 0; index < count; index++) counts[lengths[offset + index]]++;
        counts[0] = 0;

        const offsets = new Uint16Array(maximumBits + 2);
        for (let bits = 1; bits <= maximumBits; bits++) offsets[bits + 1] = offsets[bits] + counts[bits];

        const symbols = new Uint16Array(count);
        for (let index = 0; index < count; index++) {
            const length = lengths[offset + index];
            if (length !== 0) symbols[offsets[length]++] = index;
        }

        const nextCode = new Uint16Array(maximumBits + 1);
        for (let bits = 1, code = 0; bits <= maximumBits; bits++) {
            code = (code + counts[bits - 1]) << 1;
            nextCode[bits] = code;
        }

        const fast = new Uint16Array(1 << fastBits);
        for (let index = 0; index < count; index++) {
            const length = lengths[offset + index];
            if (length === 0) continue;
            const code = nextCode[length]++;
            if (length > fastBits) continue;

            // Codes are stored most significant bit first, while the stream is read least significant bit first.
            let reversed = 0;
            for (let bit = 0; bit < length; bit++) reversed |= ((code >> bit) & 1) << (length - 1 - bit);
            for (let slot = reversed; slot < fast.length; slot += 1 << length) fast[slot] = (index << 4) | length;
        }

        return { counts, symbols, fast };
    }

    function getFixedTables() {
        if (fixedTables) return fixedTables;
        const lengths = new Uint8Array(288 + 30);
        lengths.fill(8, 0, 144);
        lengths.fill(9, 144, 256);
        lengths.fill(7, 256, 280);
        lengths.fill(8, 280, 288);
        lengths.fill(5, 288, 318);
        fixedTables = { literals: createTable(lengths, 0, 288), distances: createTable(lengths, 288, 30) };
        return fixedTables;
    }

    /**
     * Inflates raw DEFLATE bytes.
     * @param {Uint8Array} input Compressed bytes.
     * @param {number} [expectedSize] Uncompressed size when known, which avoids growing the output.
     * @returns {Uint8Array} Uncompressed bytes.
     */
    function rawInflate(input, expectedSize) {
        let output = new Uint8Array(expectedSize > 0 ? expectedSize : Math.max(1024, input.length * 4));
        let outputLength = 0;
        let position = 0;
        let bitBuffer = 0;
        let bitCount = 0;

        const fail = (message) => { throw new Error("rawInflate: " + message); };

        const grow = (extra) => {
            let size = output.length * 2;
            while (size < outputLength + extra) size *= 2;
            const grown = new Uint8Array(size);
            grown.set(output.subarray(0, outputLength));
            output = grown;
        };

        const readBits = (count) => {
            while (bitCount < count) {
                if (position >= input.length) fail("unexpected end of data");
                bitBuffer |= input[position++] << bitCount;
                bitCount += 8;
            }
            const value = bitBuffer & ((1 << count) - 1);
            bitBuffer >>>= count;
            bitCount -= count;
            return value;
        };

        const decodeSymbol = (table) => {
            while (bitCount < fastBits && position < input.length) {
                bitBuffer |= input[position++] << bitCount;
                bitCount += 8;
            }
            const entry = table.fast[bitBuffer & fastMask];
            const length = entry & 15;
            if (length !== 0 && length <= bitCount) {
                bitBuffer >>>= length;
                bitCount -= length;
                return entry >> 4;
            }

            // Codes longer than the lookup are decoded bit by bit.
            let code = 0;
            let first = 0;
            let index = 0;
            for (let bits = 1; bits <= maximumBits; bits++) {
                code |= readBits(1);
                const count = table.counts[bits];
                if (code - count < first) return table.symbols[index + (code - first)];
                index += count;
                first = (first + count) << 1;
                code <<= 1;
            }
            return fail("invalid code");
        };

        const readStoredBlock = () => {
            // Stored data starts at a byte boundary; whole bytes still in the bit buffer are given back.
            const partialBits = bitCount & 7;
            bitBuffer >>>= partialBits;
            bitCount -= partialBits;
            position -= bitCount >> 3;
            bitBuffer = 0;
            bitCount = 0;

            if (position + 4 > input.length) fail("unexpected end of data");
            const length = input[position] | (input[position + 1] << 8);
            const inverse = input[position + 2] | (input[position + 3] << 8);
            if (length !== (~inverse & 0xffff)) fail("corrupt stored block");
            position += 4;
            if (position + length > input.length) fail("unexpected end of data");

            if (outputLength + length > output.length) grow(length);
            output.set(input.subarray(position, position + length), outputLength);
            outputLength += length;
            position += length;
        };

        const readDynamicTables = () => {
            const literalCount = readBits(5) + 257;
            const distanceCount = readBits(5) + 1;
            const codeLengthCount = readBits(4) + 4;
            if (literalCount > 286 || distanceCount > 30) fail("too many codes");

            const codeLengths = new Uint8Array(19);
            for (let index = 0; index < codeLengthCount; index++) codeLengths[codeLengthOrder[index]] = readBits(3);
            const codeLengthTable = createTable(codeLengths, 0, 19);

            const lengths = new Uint8Array(literalCount + distanceCount);
            for (let index = 0; index < lengths.length;) {
                const symbol = decodeSymbol(codeLengthTable);
                if (symbol < 16) {
                    lengths[index++] = symbol;
                    continue;
                }

                let value = 0;
                let repeat;
                if (symbol === 16) {
                    if (index === 0) fail("repeat without a previous length");
                    value = lengths[index - 1];
                    repeat = 3 + readBits(2);
                }
                else if (symbol === 17) repeat = 3 + readBits(3);
                else repeat = 11 + readBits(7);

                if (index + repeat > lengths.length) fail("too many lengths");
                lengths.fill(value, index, index + repeat);
                index += repeat;
            }
            if (lengths[256] === 0) fail("missing end of block code");

            return { literals: createTable(lengths, 0, literalCount), distances: createTable(lengths, literalCount, distanceCount) };
        };

        const readCompressedBlock = (tables) => {
            for (;;) {
                const symbol = decodeSymbol(tables.literals);
                if (symbol < 256) {
                    if (outputLength >= output.length) grow(1);
                    output[outputLength++] = symbol;
                    continue;
                }
                if (symbol === 256) return;

                const lengthIndex = symbol - 257;
                if (lengthIndex >= 29) fail("invalid length code");
                const length = lengthBase[lengthIndex] + readBits(lengthExtraBits[lengthIndex]);

                const distanceIndex = decodeSymbol(tables.distances);
                if (distanceIndex >= 30) fail("invalid distance code");
                const distance = distanceBase[distanceIndex] + readBits(distanceExtraBits[distanceIndex]);
                if (distance > outputLength) fail("distance too far back");

                if (outputLength + length > output.length) grow(length);
                let from = outputLength - distance;
                if (distance >= length) {
                    output.copyWithin(outputLength, from, from + length);
                    outputLength += length;
                }
                else {
                    for (let index = 0; index < length; index++) output[outputLength++] = output[from++];
                }
            }
        };

        let isFinalBlock = false;
        while (!isFinalBlock) {
            isFinalBlock = readBits(1) === 1;
            const type = readBits(2);
            if (type === 0) readStoredBlock();
            else if (type === 1) readCompressedBlock(getFixedTables());
            else if (type === 2) readCompressedBlock(readDynamicTables());
            else fail("invalid block type");
        }

        return outputLength === output.length ? output : output.subarray(0, outputLength);
    }

    window.rawInflate = rawInflate;
})();
