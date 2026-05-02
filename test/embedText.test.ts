import { describe, expect, it } from 'vitest';
import { indexedRowToEmbedText } from '../src/indexer/embedText.ts';

describe('indexedRowToEmbedText', () => {
    it('keeps path and meta summary even when content exists', () => {
        const doc = indexedRowToEmbedText({
            name: 'Affix',
            type: 'component',
            category: 'components',
            path: 'formUtils/one-ui/Components/Affix/Affix.jsx',
            description: null,
            meta: {
                props: ['offsetTop', 'offsetBottom', 'target'],
                hooks: [],
            },
            content:
                '{"name":"Affix","type":"component","description":null,"signature":"class{render():unknown}"}',
            file_hash: 'file-hash',
            semantic_hash: 'semantic-hash',
        });

        expect(doc).toContain('component Affix');
        expect(doc).toContain('formUtils/one-ui/Components/Affix/Affix.jsx');
        expect(doc).toContain('props: offsetTop, offsetBottom, target');
        expect(doc).toContain('"name":"Affix"');
    });
});
