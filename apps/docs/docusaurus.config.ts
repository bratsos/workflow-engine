import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'workflow-engine',
  tagline:
    'Type-safe, Postgres-native workflow engine for AI pipelines — batch-API economics, durable execution, provenance',
  favicon: 'img/favicon.svg',

  markdown: {
    format: 'detect',
  },

  future: {
    v4: true,
  },

  url: 'https://workflow-engine.dev',
  baseUrl: '/',

  organizationName: 'bratsos',
  projectName: 'workflow-engine',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/',
          editUrl:
            'https://github.com/bratsos/workflow-engine/tree/main/apps/docs/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      'docusaurus-plugin-typedoc',
      {
        name: 'API Reference',
        entryPoints: [
          '../../packages/workflow-engine/src/index.ts',
          '../../packages/workflow-engine/src/client.ts',
          '../../packages/workflow-engine/src/testing/index.ts',
          '../../packages/workflow-engine/src/kernel/index.ts',
        ],
        tsconfig: './typedoc.tsconfig.json',
        skipErrorChecking: true,
        readme: 'none',
        out: 'docs/api',
        sidebar: {pretty: true},
      },
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'workflow-engine',
      logo: {
        alt: 'workflow-engine logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/api/',
          label: 'API Reference',
          position: 'left',
        },
        {
          href: 'https://github.com/bratsos/workflow-engine',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Introduction',
              to: '/',
            },
            {
              label: 'Core Concepts',
              to: '/core-concepts/',
            },
            {
              label: 'API Reference',
              to: '/api/',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/bratsos/workflow-engine',
            },
            {
              label: 'npm',
              href: 'https://www.npmjs.com/package/@bratsos%2Fworkflow-engine',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} workflow-engine. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
