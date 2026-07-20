import { describe, it, expect } from 'vitest';
import { sanitizeHtml, sanitizeA11yTree, a11yTreeToCompactJson, estimateTokens } from './sanitizers.js';

describe('sanitizeHtml', () => {
  it('removes script tags and contents', () => {
    const html = '<div>Hello</div><script>alert("xss")</script><p>World</p>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('alert');
    expect(result).toContain('<div>Hello</div>');
    expect(result).toContain('<p>World</p>');
  });

  it('removes style tags and contents', () => {
    const html = '<style>.foo { color: red; }</style><div>Content</div>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('<style>');
    expect(result).not.toContain('color: red');
    expect(result).toContain('<div>Content</div>');
  });

  it('removes noscript tags', () => {
    const html = '<noscript>Enable JavaScript</noscript><div>Main</div>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('<noscript>');
    expect(result).not.toContain('Enable JavaScript');
  });

  it('removes HTML comments', () => {
    const html = '<!-- This is a comment --><div>Visible</div>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('<!--');
    expect(result).not.toContain('comment');
    expect(result).toContain('<div>Visible</div>');
  });

  it('removes SVG path data while keeping element structure', () => {
    const html = '<svg><path d="M0 0 L100 100 Z"></path></svg>';
    const result = sanitizeHtml(html);
    expect(result).toContain('<svg>');
    expect(result).toContain('<path');
    expect(result).not.toContain('M0 0 L100 100');
  });

  it('removes inline event handlers', () => {
    const html = '<button onclick="handleClick()" onmouseover="hover()">Click</button>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('onmouseover');
    expect(result).toContain('<button');
    expect(result).toContain('Click</button>');
  });

  it('removes data-* attributes except data-testid', () => {
    const html = '<div data-analytics="track" data-testid="my-div" data-value="123">Content</div>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('data-analytics');
    expect(result).not.toContain('data-value');
    expect(result).toContain('data-testid="my-div"');
  });

  it('removes inline styles', () => {
    const html = '<div style="color: red; font-size: 16px;">Styled</div>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('style=');
    expect(result).not.toContain('color: red');
    expect(result).toContain('<div>Styled</div>');
  });

  it('removes class attributes', () => {
    const html = '<div class="container flex-row bg-blue-500">Content</div>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('class=');
    expect(result).not.toContain('container');
    expect(result).toContain('<div>Content</div>');
  });

  it('removes srcset attribute', () => {
    const html = '<img src="img.jpg" srcset="img-2x.jpg 2x, img-3x.jpg 3x" alt="Image">';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('srcset');
    expect(result).toContain('src="img.jpg"');
    expect(result).toContain('alt="Image"');
  });

  it('removes link stylesheet tags', () => {
    const html = '<link rel="stylesheet" href="/styles.css"><div>Content</div>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('<link');
    expect(result).not.toContain('stylesheet');
    expect(result).toContain('<div>Content</div>');
  });

  it('removes meta tags', () => {
    const html = '<meta name="description" content="Test"><meta property="og:title" content="Title"><div>Content</div>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('<meta');
    expect(result).not.toContain('og:title');
    expect(result).toContain('<div>Content</div>');
  });

  it('removes SVG visual attributes', () => {
    const html =
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle fill="red" stroke="blue"></circle></svg>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('viewBox');
    expect(result).not.toContain('xmlns');
    expect(result).not.toContain('fill=');
    expect(result).not.toContain('stroke=');
    expect(result).toContain('<svg>');
    expect(result).toContain('<circle>');
  });

  it('removes empty attributes', () => {
    const html = '<script nonce="" async="">code</script><div data-empty="">Content</div>';
    const result = sanitizeHtml(html);
    // Script is removed entirely, but empty attrs on remaining elements should be gone
    expect(result).not.toContain('nonce=""');
  });

  it('collapses whitespace', () => {
    const html = '<div>   Multiple   spaces   </div>\n\n<p>New paragraph</p>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('   ');
    expect(result).not.toContain('\n\n');
  });

  it('preserves accessibility-relevant attributes', () => {
    const html = '<button aria-label="Close" role="button" tabindex="0">X</button>';
    const result = sanitizeHtml(html);
    expect(result).toContain('aria-label="Close"');
    expect(result).toContain('role="button"');
    expect(result).toContain('tabindex="0"');
  });

  it('preserves form-related attributes', () => {
    const html = '<input type="text" name="email" id="email" required autocomplete="email">';
    const result = sanitizeHtml(html);
    expect(result).toContain('type="text"');
    expect(result).toContain('name="email"');
    expect(result).toContain('id="email"');
    expect(result).toContain('required');
    expect(result).toContain('autocomplete="email"');
  });
});

describe('sanitizeA11yTree', () => {
  it('removes leaf nodes with role "none"', () => {
    const tree = {
      role: 'document',
      children: [
        { role: 'none', name: 'decorative' },
        { role: 'button', name: 'Click me' },
      ],
    };
    const result = sanitizeA11yTree(tree);
    expect(result?.children).toHaveLength(1);
    expect(result?.children?.[0]?.role).toBe('button');
  });

  it('keeps "none" nodes that have children', () => {
    const tree = {
      role: 'document',
      children: [{ role: 'none', children: [{ role: 'button', name: 'Inside' }] }],
    };
    const result = sanitizeA11yTree(tree);
    expect(result?.children).toHaveLength(1);
    expect(result?.children?.[0]?.children?.[0]?.name).toBe('Inside');
  });

  it('removes leaf nodes with role "presentation"', () => {
    const tree = {
      role: 'document',
      children: [{ role: 'presentation' }, { role: 'heading', name: 'Title' }],
    };
    const result = sanitizeA11yTree(tree);
    expect(result?.children).toHaveLength(1);
    expect(result?.children?.[0]?.role).toBe('heading');
  });

  it('strips "generic" role but keeps node structure', () => {
    const tree = {
      role: 'document',
      children: [{ role: 'generic', children: [{ role: 'button', name: 'Click' }] }],
    };
    const result = sanitizeA11yTree(tree);
    expect(result?.children).toHaveLength(1);
    expect(result?.children?.[0]?.role).toBeUndefined();
    expect(result?.children?.[0]?.children?.[0]?.role).toBe('button');
  });

  it('removes whitespace-only StaticText nodes', () => {
    const tree = {
      role: 'document',
      children: [
        { role: 'StaticText', name: '   ' },
        { role: 'StaticText', name: 'Real text' },
      ],
    };
    const result = sanitizeA11yTree(tree);
    expect(result?.children).toHaveLength(1);
    expect(result?.children?.[0]?.name).toBe('Real text');
  });

  it('preserves accessibility-relevant properties', () => {
    const tree = {
      role: 'checkbox',
      name: 'Accept terms',
      checked: true,
      disabled: false,
      required: true,
    };
    const result = sanitizeA11yTree(tree);
    expect(result?.role).toBe('checkbox');
    expect(result?.name).toBe('Accept terms');
    expect(result?.checked).toBe(true);
    expect(result?.required).toBe(true);
    // disabled: false should be omitted
    expect(result?.disabled).toBeUndefined();
  });

  it('removes empty values', () => {
    const tree = {
      role: 'button',
      name: 'Click',
      description: '',
      value: undefined,
    };
    const result = sanitizeA11yTree(tree);
    expect(result?.role).toBe('button');
    expect(result?.name).toBe('Click');
    expect(result?.description).toBeUndefined();
    expect(result?.value).toBeUndefined();
  });

  it('trims string values', () => {
    const tree = {
      role: 'button',
      name: '  Submit Form  ',
    };
    const result = sanitizeA11yTree(tree);
    expect(result?.name).toBe('Submit Form');
  });

  it('handles null input', () => {
    const result = sanitizeA11yTree(null);
    expect(result).toBeNull();
  });

  it('recursively processes children', () => {
    const tree = {
      role: 'document',
      children: [
        {
          role: 'navigation',
          children: [{ role: 'none' }, { role: 'link', name: 'Home' }],
        },
      ],
    };
    const result = sanitizeA11yTree(tree);
    expect(result?.children?.[0]?.children).toHaveLength(1);
    expect(result?.children?.[0]?.children?.[0]?.name).toBe('Home');
  });
});

describe('a11yTreeToCompactJson', () => {
  it('produces compact JSON without pretty printing', () => {
    const tree = {
      role: 'document',
      children: [{ role: 'heading', name: 'Title' }],
    };
    const result = a11yTreeToCompactJson(tree);
    expect(result).not.toContain('\n');
    expect(result).toBe('{"role":"document","children":[{"role":"heading","name":"Title"}]}');
  });

  it('handles null input', () => {
    const result = a11yTreeToCompactJson(null);
    expect(result).toBe('{}');
  });
});

describe('estimateTokens', () => {
  it('estimates roughly 4 characters per token', () => {
    const text = 'This is a test string with 40 characters.';
    const estimate = estimateTokens(text);
    // 41 chars / 4 = ~10.25, rounded up = 11
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(20);
  });

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('integration: token reduction', () => {
  it('significantly reduces tokens on realistic HTML', () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          .container { display: flex; }
          .btn { background: blue; }
        </style>
        <script>
          function init() {
            console.log('initialized');
          }
        </script>
      </head>
      <body class="container flex-col" style="margin: 0;">
        <nav onclick="toggleMenu()" class="nav-menu" data-tracking="nav">
          <a href="/" class="logo">Home</a>
        </nav>
        <main>
          <svg viewBox="0 0 100 100">
            <path d="M10 10 L90 10 L90 90 L10 90 Z" fill="red"></path>
          </svg>
          <button aria-label="Submit">Go</button>
        </main>
        <!-- Footer comment -->
      </body>
      </html>
    `;

    const sanitized = sanitizeHtml(html);

    // Should remove script, style, comments
    expect(sanitized).not.toContain('<script>');
    expect(sanitized).not.toContain('<style>');
    expect(sanitized).not.toContain('<!--');

    // Should remove non-semantic attributes
    expect(sanitized).not.toContain('onclick');
    expect(sanitized).not.toContain('class=');
    expect(sanitized).not.toContain('style=');
    expect(sanitized).not.toContain('data-tracking');

    // Should preserve accessibility attributes
    expect(sanitized).toContain('aria-label="Submit"');
    expect(sanitized).toContain('href="/"');

    // Should be significantly smaller
    expect(sanitized.length).toBeLessThan(html.length * 0.5);
  });
});
