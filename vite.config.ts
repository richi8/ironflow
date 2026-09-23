import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the build works from a GitHub Pages project subpath.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    open: false,
  },
});
