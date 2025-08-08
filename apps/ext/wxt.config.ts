// import tailwindcss from '@tailwindcss/vite';
// import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ mode }) => {
    return {
      name: mode !== 'production' ? 'TabTrackr Dev' : 'TabTrackr',
      description: 'Track your browsing habits and boost productivity with team insights',
      permissions: ['tabs', 'activeTab', 'storage', 'identity', 'alarms'],
      host_permissions: ['<all_urls>'],
      content_security_policy: {
        extension_pages:
          mode !== 'production'
            ? "script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules'; object-src 'self'"
            : "script-src 'self'; object-src 'self'",
      },
    };
  },
  srcDir: 'src',
  zip: {
    name: 'tab-trackr',
  },
  // vite: () => ({
  //   plugins: [react({ devTarget: 'esnext' }), tailwindcss()],
  //   build: {
  //     target: 'esnext',
  //   },
  // }),
});
