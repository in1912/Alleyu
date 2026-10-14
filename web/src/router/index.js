import { createRouter, createWebHashHistory } from 'vue-router';
import { token } from '../api/index.js';

const routes = [
  { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue') },
  { path: '/plan', name: 'plan', component: () => import('../views/PlanView.vue') },
  { path: '/history', name: 'history', component: () => import('../views/HistoryView.vue') },
  { path: '/guide/:id', name: 'guide', component: () => import('../views/GuideView.vue') },
  { path: '/library', name: 'library', component: () => import('../views/LibraryView.vue') },
  { path: '/weather', name: 'weather', component: () => import('../views/WeatherView.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
  { path: '/users', name: 'users', component: () => import('../views/UsersView.vue') },
  { path: '/s/:token', name: 'share', component: () => import('../views/ShareView.vue') }, // 公开分享页（免登录）
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach((to) => {
  if (to.name !== 'login' && to.name !== 'share' && !token()) return { name: 'login' };
  return true;
});

export default router;
