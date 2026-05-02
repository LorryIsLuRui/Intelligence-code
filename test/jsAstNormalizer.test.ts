import { describe, expect, it } from 'vitest';
import * as babelParser from '@babel/parser';
import { computeSemanticHashJs } from '../src/indexer/jsAstNormalizer.ts';

describe('computeSemanticHashJs', () => {
    it('does not include callee names in stable payload (moved to ranking signal)', () => {
        const ast = babelParser.parse(
            'class Affix { render() { return null; } }',
            {
                sourceType: 'module',
                plugins: ['jsx', 'typescript'],
            }
        );
        const classNode = ast.program.body[0];

        const [, stableStr] = computeSemanticHashJs({
            name: 'Affix',
            type: 'component',
            description: null,
            meta: {
                callees: [
                    { name: 'throttle', path: 'utils/throttle.js' },
                    { name: 'getOffsetTop', path: 'utils/dom.js' },
                    {
                        name: 'addEventListener',
                        path: 'utils/eventListener.js',
                    },
                ],
            },
            node: classNode,
        });

        const stable = JSON.parse(stableStr) as {
            calleeNames?: string[];
        };

        // ✨ calleeNames removed from semantic hash to keep it pure
        // Now used as independent ranking signal in rankSemanticHits()
        expect(stable.calleeNames).toBeUndefined();
    });

    it('captures affix-like fixed and offset behavior in stable payload', () => {
        const code = `
class Affix {
  componentDidMount() {
    addEventListener(window, 'scroll', throttle(this.updatePosition, 10));
  }
  updatePosition() {
    const offsetTop = this.props.offsetTop;
    const scrollTop = getScroll(window, true);
        const offset = getOffsetTop(this.affixNode, window);
        return { position: 'fixed', top: offsetTop, scrollTop, offset };
  }
}
`;
        const ast = babelParser.parse(code, {
            sourceType: 'module',
            plugins: ['jsx', 'typescript'],
        });
        const classNode = ast.program.body[0];

        const [, stableStr] = computeSemanticHashJs({
            name: 'Affix',
            type: 'component',
            description: 'Affix 固钉组件',
            meta: {},
            node: classNode,
        });

        const stable = JSON.parse(stableStr) as {
            behavior?: string[];
        };

        expect(stable.behavior).toEqual(
            expect.arrayContaining([
                'computes element offset',
                'listens to viewport events',
                'supports offset positioning',
                'throttles position updates',
                'tracks scroll position',
                'uses fixed positioning',
            ])
        );
    });
});
