import { initializeApp } from 'firebase/app';
import { getAnalytics, type Analytics } from 'firebase/analytics';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updatePassword,
  type User,
} from 'firebase/auth';
import type {
  ActivityLogItem,
  AdUnlockRecord,
  BannerItem,
  CommentItem,
  ContactMessage,
  CustomPage,
  EpisodeItem,
  GenreItem,
  MovieItem,
  ReportItem,
  SiteSettings,
  SubscriptionPlan,
  UserProfile,
  WatchHistoryItem,
  WatchlistItem,
} from '../types/streaming';
import {
  DEFAULT_SITE_SETTINGS,
  SEED_BANNERS,
  SEED_COMMENTS,
  SEED_EPISODES,
  SEED_GENRES,
  SEED_MOVIES,
  SEED_PAGES,
  SEED_PLANS,
} from '../data/seedCatalog';
import { mergeSiteSettings } from '../utils/customization';

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: 'AIzaSyCaamGgKek0SOHfxqnU-00joLX-dA9DFh4',
  authDomain: 'ainame-76af5.firebaseapp.com',
  projectId: 'ainame-76af5',
  storageBucket: 'ainame-76af5.firebasestorage.app',
  messagingSenderId: '74950641528',
  appId: '1:74950641528:web:2f693a76eb7c49f99b6a8d',
  measurementId: 'G-BYBN37NSST',
};

// Initialize Firebase in one place only
export const app = initializeApp(firebaseConfig);
export let analytics: Analytics | null = null;
if (typeof window !== 'undefined') {
  try {
    analytics = getAnalytics(app);
  } catch {
    analytics = null;
  }
}
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export const BOOTSTRAPPED_ADMIN_EMAIL = 'krushnachaware84@gmail.com';

export function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((v) => v !== undefined)
      .map((v) => stripUndefinedDeep(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v);
      }
    }
    return out as T;
  }
  return value;
}

export type AuthErrorFlow = 'signin' | 'signup' | 'other';

export function mapFirebaseAuthError(error: unknown, flow: AuthErrorFlow): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';

  if (flow === 'signin') {
    if (
      code === 'auth/wrong-password' ||
      code === 'auth/user-not-found' ||
      code === 'auth/invalid-credential'
    ) {
      return 'Email or password is incorrect';
    }
  }

  if (flow === 'signup') {
    if (code === 'auth/email-already-in-use') {
      return 'User already exists. Please sign in';
    }
  }

  return 'Something went wrong. Please try again.';
}

export function buildTransientUserProfile(user: User): UserProfile {
  const nowIso = new Date().toISOString();
  const isBootstrapAdmin =
    user.email === BOOTSTRAPPED_ADMIN_EMAIL && user.emailVerified;
  return {
    uid: user.uid,
    displayName: user.displayName || user.email?.split('@')[0] || 'Member',
    email: user.email || '',
    photoURL: user.photoURL || '',
    role: isBootstrapAdmin ? 'admin' : 'user',
    status: 'active',
    plan: isBootstrapAdmin ? 'premium' : 'free',
    subscriptionPlanId: null,
    subscriptionPlanName: null,
    planExpiresAt: null,
    createdAt: user.metadata?.creationTime || nowIso,
    lastLoginAt: user.metadata?.lastSignInTime || nowIso,
  };
}

export function isUserAdmin(profile: UserProfile | null, authUser: User | null): boolean {
  if (!authUser) return false;
  if (authUser.email === BOOTSTRAPPED_ADMIN_EMAIL && authUser.emailVerified) return true;
  return profile?.role === 'admin';
}

// --- Firebase Authentication Only ---

export async function signInWithGooglePopup(): Promise<User> {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    throw new Error(mapFirebaseAuthError(error, 'other'));
  }
}

export async function signInWithEmail(email: string, password: string): Promise<User> {
  try {
    const result = await signInWithEmailAndPassword(auth, email, password);
    return result.user;
  } catch (error) {
    throw new Error(mapFirebaseAuthError(error, 'signin'));
  }
}

export async function registerWithEmail(
  email: string,
  password: string,
  _displayName?: string
): Promise<User> {
  try {
    const result = await createUserWithEmailAndPassword(auth, email, password);
    return result.user;
  } catch (error) {
    throw new Error(mapFirebaseAuthError(error, 'signup'));
  }
}

export async function sendResetPassword(email: string): Promise<void> {
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (error) {
    throw new Error(mapFirebaseAuthError(error, 'other'));
  }
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export async function updateCurrentUserPassword(newPassword: string): Promise<void> {
  if (!auth.currentUser) throw new Error('Something went wrong. Please try again.');
  try {
    await updatePassword(auth.currentUser, newPassword);
  } catch (error) {
    throw new Error(mapFirebaseAuthError(error, 'other'));
  }
}

export async function deleteCurrentUserAccount(): Promise<void> {
  const current = auth.currentUser;
  if (!current) throw new Error('Something went wrong. Please try again.');
  try {
    await deleteUser(current);
  } catch (error) {
    throw new Error(mapFirebaseAuthError(error, 'other'));
  }
}

// Transient session derivation only — no user profile persistence anywhere
export async function syncUserProfileOnLogin(user: User): Promise<UserProfile> {
  return buildTransientUserProfile(user);
}

export async function updateOwnUserProfile(
  _uid: string,
  _updates: { displayName?: string; photoURL?: string }
): Promise<void> {
  // No user profile storage enabled (Firebase Auth only)
}

export function uploadFileWithProgress(
  _storagePath: string,
  _file: File,
  _onProgress?: (pct: number) => void
): Promise<string> {
  return Promise.reject(new Error('File uploads are disabled in Authentication-only mode.'));
}

export async function testFirestoreConnection(): Promise<boolean> {
  return false;
}

// --- In-Memory Seed Catalog Helpers (Zero Firestore / Zero Storage) ---

export async function fetchSiteSettings(): Promise<SiteSettings> {
  return mergeSiteSettings(DEFAULT_SITE_SETTINGS);
}

export async function fetchPublishedPages(): Promise<CustomPage[]> {
  return SEED_PAGES;
}

export async function createContactMessage(
  msg: Omit<ContactMessage, 'id' | 'status' | 'createdAt'>
): Promise<ContactMessage> {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: msg.name.trim().slice(0, 100),
    email: msg.email.trim().slice(0, 200),
    subject: msg.subject.trim().slice(0, 160),
    message: msg.message.trim().slice(0, 3000),
    pageSlug: (msg.pageSlug || 'contact').slice(0, 80),
    status: 'unread',
    createdAt: new Date().toISOString(),
  };
}

export async function fetchPublishedCatalog(_maxCount = 60): Promise<{
  movies: MovieItem[];
  genres: GenreItem[];
  banners: BannerItem[];
  plans: SubscriptionPlan[];
  fromSeed: boolean;
}> {
  return {
    movies: SEED_MOVIES,
    genres: SEED_GENRES,
    banners: SEED_BANNERS,
    plans: SEED_PLANS,
    fromSeed: true,
  };
}

export async function subscribeUserToPlan(
  _uid: string,
  plan: SubscriptionPlan
): Promise<{ plan: 'premium'; subscriptionPlanId: string; subscriptionPlanName: string; planExpiresAt: string }> {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    plan: 'premium',
    subscriptionPlanId: plan.id,
    subscriptionPlanName: plan.name.slice(0, 100),
    planExpiresAt: expiresAt,
  };
}

export async function cancelUserSubscription(_uid: string): Promise<void> {
  // No Firestore persistence
}

export async function fetchSeriesEpisodes(seriesId: string): Promise<EpisodeItem[]> {
  return SEED_EPISODES[seriesId] ?? [];
}

export async function fetchUserPersonalData(_uid: string): Promise<{
  watchlist: WatchlistItem[];
  history: WatchHistoryItem[];
  ratings: Record<string, number>;
  likes: string[];
}> {
  return { watchlist: [], history: [], ratings: {}, likes: [] };
}

export async function toggleUserWatchlist(_uid: string, _movieId: string, _add: boolean): Promise<void> {}
export async function saveUserWatchHistory(_uid: string, _entry: WatchHistoryItem): Promise<void> {}
export async function removeUserHistoryItem(_uid: string, _movieId: string): Promise<void> {}
export async function clearUserHistory(_uid: string, _movieIds: string[]): Promise<void> {}
export async function saveUserRating(_uid: string, _movieId: string, _value: number): Promise<void> {}
export async function toggleUserLike(_uid: string, _movieId: string, _liked: boolean): Promise<void> {}
export async function incrementMovieViews(_movieId: string): Promise<void> {}

export async function fetchMovieComments(movieId: string): Promise<CommentItem[]> {
  return SEED_COMMENTS.filter((c) => c.movieId === movieId);
}

export async function createComment(comment: Omit<CommentItem, 'id'>): Promise<CommentItem> {
  return {
    id: `cmt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ...comment,
  };
}

export async function deleteCommentDoc(_commentId: string): Promise<void> {}

export async function createReportDoc(
  report: Omit<ReportItem, 'id' | 'status' | 'createdAt'>
): Promise<ReportItem> {
  return {
    id: `rep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ...report,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
}

// --- Admin In-Memory Compatibility Helpers ---

export async function logAdminAction(_adminUid: string, _action: string, _targetId: string): Promise<void> {}

export async function fetchAllAdminData(): Promise<{
  movies: MovieItem[];
  genres: GenreItem[];
  banners: BannerItem[];
  plans: SubscriptionPlan[];
  users: UserProfile[];
  comments: CommentItem[];
  reports: ReportItem[];
  pages: CustomPage[];
  messages: ContactMessage[];
  logs: ActivityLogItem[];
  settings: SiteSettings;
}> {
  return {
    movies: SEED_MOVIES,
    genres: SEED_GENRES,
    banners: SEED_BANNERS,
    plans: SEED_PLANS,
    users: [],
    comments: SEED_COMMENTS,
    reports: [],
    pages: SEED_PAGES,
    messages: [],
    logs: [],
    settings: mergeSiteSettings(DEFAULT_SITE_SETTINGS),
  };
}

export async function saveMovieDoc(_movie: MovieItem, _adminUid: string, _isNew: boolean): Promise<void> {}
export async function deleteMovieDoc(_movieId: string, _adminUid: string): Promise<void> {}
export async function saveEpisodeDoc(_episode: EpisodeItem, _adminUid: string): Promise<void> {}
export async function deleteEpisodeDoc(
  _seriesId: string,
  _seasonId: string,
  _episodeId: string,
  _adminUid: string
): Promise<void> {}
export async function saveGenreDoc(_genre: GenreItem, _adminUid: string): Promise<void> {}
export async function deleteGenreDoc(_genreId: string, _adminUid: string): Promise<void> {}
export async function saveBannerDoc(_banner: BannerItem, _adminUid: string): Promise<void> {}
export async function deleteBannerDoc(_bannerId: string, _adminUid: string): Promise<void> {}
export async function updateAdminUserDoc(
  _targetUid: string,
  _updates: Partial<UserProfile>,
  _adminUid: string
): Promise<void> {}
export async function deleteAdminUserDoc(_targetUid: string, _adminUid: string): Promise<void> {}
export async function toggleCommentVisibility(
  _commentId: string,
  _isHidden: boolean,
  _adminUid: string
): Promise<void> {}
export async function updateReportStatus(
  _reportId: string,
  _status: 'open' | 'resolved',
  _adminUid: string
): Promise<void> {}
export async function saveSiteSettingsDoc(_settings: SiteSettings, _adminUid: string): Promise<void> {}
export async function savePlanDoc(_plan: SubscriptionPlan, _adminUid: string, _isNew: boolean): Promise<void> {}
export async function deletePlanDoc(_planId: string, _adminUid: string): Promise<void> {}
export async function saveCustomPageDoc(_page: CustomPage, _adminUid: string, _isNew: boolean): Promise<void> {}
export async function deleteCustomPageDoc(_pageId: string, _adminUid: string): Promise<void> {}
export async function updateContactMessageStatus(
  _messageId: string,
  _status: 'unread' | 'read' | 'archived',
  _adminUid: string
): Promise<void> {}
export async function deleteContactMessageDoc(_messageId: string, _adminUid: string): Promise<void> {}
export async function seedCatalogToFirestore(_adminUid: string): Promise<void> {}

export async function fetchUserAdUnlocks(_uid: string): Promise<Record<string, AdUnlockRecord>> {
  return {};
}
export async function saveUserAdUnlock(_uid: string, _record: AdUnlockRecord): Promise<void> {}
export async function consumeUserFallbackUnlock(
  _uid: string,
  _contentId: string,
  _remainingPlaybacks: number
): Promise<void> {}
export async function batchSaveEpisodeAccess(_episodes: EpisodeItem[], _adminUid: string): Promise<void> {}
export async function seedAdUnlockDatasetToFirestore(_adminUid: string): Promise<void> {}
