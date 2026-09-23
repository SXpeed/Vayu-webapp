// Response helpers and D1 row mappers shared by worker.ts and the delta-sync
// endpoint (frontend/deltaSync.ts). Extracted so both can import them without
// a circular import between the two modules.
import { databaseKey } from './workerEnv';

export const CORS: HeadersInit = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', ...CORS },
  });
}

export function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ── D1 row mappers ──────────────────────────────────────────────────────────

export function rowToConversation(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    participantIds: JSON.parse(row.participant_ids as string),
    participantNames: JSON.parse(row.participant_names as string),
    lastMessage: row.last_message as string,
    lastMessageTime: row.last_message_time as number,
    unreadCount: row.unread_count as number,
    title: row.title || undefined,
    reason: row.reason || undefined,
    note: row.note || undefined,
    isGroup: !!row.is_group,
    groupName: row.group_name || undefined,
    isPinned: !!row.is_pinned,
    isArchived: !!row.is_archived,
    isPrivate: !!row.is_private,
    createdBy: row.created_by || undefined,
  };
}

export function rowToMessage(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    senderId: row.sender_id as string,
    senderName: row.sender_name as string,
    text: row.text as string,
    tags: JSON.parse(row.tags as string),
    timestamp: row.timestamp as number,
    status: row.status as string,
    replyTo: row.reply_to ? JSON.parse(row.reply_to as string) : undefined,
    attachment: row.attachment ? JSON.parse(row.attachment as string) : undefined,
  };
}

export function rowToArtwork(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    customId: row.custom_id as string,
    title: row.title as string,
    description: row.description as string,
    dimensions: row.dimensions as string,
    medium: row.medium as string,
    status: row.status as string,
    location: row.location as string,
    price: row.price as number,
    imageUrls: JSON.parse(row.image_urls as string),
    createdAt: row.created_at as number,
    artist: (row.artist as string) || undefined,
    artworkYear: (row.artwork_year as string) || undefined,
    descriptionTitle: (row.description_title as string) || undefined,
    plusGst: !!row.plus_gst,
  };
}

export function rowToCollection(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    artworkIds: JSON.parse(row.artwork_ids as string),
    coverImageUrl: (row.cover_image_url as string) || undefined,
    createdAt: row.created_at as number,
  };
}

export function rowToCatalog(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    artworkIds: JSON.parse(row.artwork_ids as string),
    coverImageUrl: row.cover_image_url as string,
    pdfUrl: (row.pdf_url as string) || undefined,
    source: (row.source as string) || undefined,
    createdAt: row.created_at as number,
  };
}

export function rowToInquiry(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    inquiryNumber: row.inquiry_number as string,
    customerName: row.customer_name as string,
    customerPhone: row.customer_phone as string,
    customerEmail: row.customer_email as string,
    customerAddress: (row.customer_address as string) || undefined,
    artworkIds: JSON.parse(row.artwork_ids as string),
    notes: row.notes as string,
    source: row.source as string,
    status: row.status as string,
    catalogShared: !!row.catalog_shared,
    date: row.date as number,
    createdBy: (row.created_by as string) || undefined,
    createdByName: (row.created_by_name as string) || undefined,
    imageUrls: row.image_urls ? JSON.parse(row.image_urls as string) : [],
  };
}

export function rowToInquiryMessage(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    inquiryId: row.inquiry_id as string,
    senderId: row.sender_id as string,
    senderName: row.sender_name as string,
    text: row.text as string,
    tags: JSON.parse(row.tags as string),
    timestamp: row.timestamp as number,
    status: row.status as string,
    replyTo: row.reply_to ? JSON.parse(row.reply_to as string) : undefined,
    attachment: row.attachment ? JSON.parse(row.attachment as string) : undefined,
  };
}

/** The whole Invoice JSON lives in the `data` column (shape owned by the app). */
export function rowToInvoice(row: Record<string, unknown>): any {
  return JSON.parse(row.data as string);
}

export function rowToEvent(row: Record<string, unknown>): any {
  let todos: any[] = [];
  try { todos = row.todos ? JSON.parse(row.todos as string) : []; } catch { todos = []; }
  return {
    id: row.id as string,
    title: (row.title as string) || '',
    date: row.event_date as number,
    endDate: (row.end_date as number) || undefined,
    notes: row.notes || undefined,
    color: (row.color as string) || undefined,
    todos,
    createdAt: row.created_at as number,
    createdBy: row.created_by || undefined,
    createdByName: row.created_by_name || undefined,
  };
}

export function rowToContact(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    name: (row.name as string) || '',
    phone: (row.phone as string) || '',
    email: row.email || undefined,
    notes: row.notes || undefined,
    source: (row.source as string) || 'manual',
    createdAt: row.created_at as number,
    createdBy: row.created_by || undefined,
    createdByName: row.created_by_name || undefined,
  };
}

export function rowToStore(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    name: (row.name as string) || '',
    latitude: row.latitude as number,
    longitude: row.longitude as number,
    gpsRadius: row.gps_radius as number,
    wifiRequired: !!(row.wifi_required),
    wifiSsid: (row.wifi_ssid as string) || '',
    createdAt: row.created_at as number,
  };
}

export function rowToAttendance(row: Record<string, unknown>): any {
  return {
    id: row.id as string,
    employeeId: row.employee_id as string,
    employeeName: (row.employee_name as string) || '',
    storeId: row.store_id as string,
    checkInAt: row.check_in_at as number | null,
    checkInLat: row.check_in_lat as number | null,
    checkInLng: row.check_in_lng as number | null,
    checkInAccuracy: row.check_in_accuracy as number | null,
    checkOutAt: row.check_out_at as number | null,
    checkOutLat: row.check_out_lat as number | null,
    checkOutLng: row.check_out_lng as number | null,
    checkOutAccuracy: row.check_out_accuracy as number | null,
    connectionType: (row.connection_type as string) || 'unknown',
    status: row.status as string,
    createdAt: row.created_at as number,
  };
}

// ── Route normalisation for metrics ────────────────────────────────────────
// /artworks/abc_123 → /artworks/:id. Record ids are UUID-ish TEXT values, so
// anything that is not a known literal segment collapses to :id. Only the
// normalized route is recorded — never the query string.

const LITERAL_SEGMENTS = new Set([
  'auth', 'status', 'setup', 'login', 'logout', 'me', 'users', 'team', 'roles',
  'presence', 'heartbeat', 'offline', 'activity-logs', 'upload', 'files',
  'files-missing-thumbs', 'files-thumbs', 'conversations', 'messages',
  'status-batch', 'artworks', 'collections', 'catalogs', 'inquiries',
  'inquiry-messages', 'events', 'invoices', 'contacts', 'import',
  'deleted-items', 'restore', 'settings', 'push', 'public-key', 'subscribe',
  'unsubscribe', 'holidays', 'attendance', 'stores', 'records', 'check-in',
  'check-out', 'payments', 'link', 'links', 'webhook', 'sync', 'realtime',
  'ticket', 'ws',
]);

export function normalizeRoute(path: string): string {
  const clean = path.split('?')[0].replace(/^\/api/, '');
  const parts = clean.split('/').filter(Boolean);
  const out = parts.map((part, i) => {
    if (LITERAL_SEGMENTS.has(part)) return part;
    return ':id';
  });
  const route = '/' + out.join('/');
  return route.length > 80 ? route.slice(0, 80) : route;
}

/**
 * Run a table's one-time schema setup (CREATE TABLE / ALTER TABLE) at most
 * once per isolate — remembering only a *completed* setup.
 *
 * These used to cache the in-flight promise in a module variable and share
 * it with later requests. On Workers, I/O belongs to the request that started
 * it: when that first request was cancelled (the app closed mid-load), its
 * database calls were cancelled too, the shared promise never settled, and
 * every later request awaiting it hung forever on that isolate — which is
 * how GET /catalogs and /events stopped answering. Now each request does its
 * own (idempotent) setup until one finishes.
 */
const setupDone = new Set<string>();
export async function runSetupOnce(db: D1Database, key: string, setup: () => Promise<unknown>): Promise<void> {
  // Per database: one isolate serves many organizations, each with its own.
  const done = `${databaseKey(db)}|${key}`;
  if (setupDone.has(done)) return;
  await setup();
  setupDone.add(done);
}

