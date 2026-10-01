export type SchemaVersion = "event-v0.3";

export type SourceKind =
  | "elder"
  | "family_observation"
  | "family_report"
  | "caregiver"
  | "clinician_evidence"
  | "document"
  | "audio_transcript"
  | "system"
  | "unknown";

export type EventKind =
  | "symptom"
  | "measurement"
  | "medication"
  | "instruction"
  | "document"
  | "question"
  | "handoff"
  | "other";

export type EventState =
  | "inbox"
  | "draft"
  | "needs_review"
  | "recorded"
  | "superseded";

export type TimeCertainty =
  | "exact"
  | "range"
  | "daypart"
  | "relative"
  | "unknown";

export type ReviewRole =
  | "none"
  | "family"
  | "clinician_or_pharmacist"
  | "emergency_services";

export type EscalationLevel = "none" | "urgent" | "emergency";

export type ForbiddenAction =
  | "diagnosis"
  | "medication_change"
  | "source_overwrite"
  | "invented_time_or_dose";

export type AiDraftTime = {
  occurred: string | null;
  recorded: string;
  certainty: TimeCertainty;
};

export type AiDraftClaim = {
  text: string;
  source_kind: SourceKind;
  record_id: string;
  quote: string | null;
};

export type AiDraftConflict = {
  present: boolean;
  record_refs: string[];
};

/** AI output validated against config/event-v0.3.schema.json. */
export type AiDraft = {
  schema_version: SchemaVersion;
  event_kind: EventKind;
  summary: string;
  time: AiDraftTime;
  claims: [AiDraftClaim, ...AiDraftClaim[]];
  review_required: true;
  review_role: ReviewRole;
  escalation_level: EscalationLevel;
  conflict: AiDraftConflict;
  provenance_preserved: true;
  plan_change_allowed: false;
  follow_up_questions?: string[];
  forbidden_actions?: ForbiddenAction[];
};

/** Offline safety scan stored outside the AI draft. A non-match is not medical clearance. */
export type SafetyHistory = {
  previous_rule_version?: string;
  previous_danger_detected?: boolean;
  previous_matched_rules?: string[];
  historical_notice_preserved?: boolean;
  clinical_review_flags?: string[];
  clinical_review_required?: boolean;
  clinical_review_role?: 'clinician_or_pharmacist' | null;
  clinical_review_notice?: string | null;
  clinical_review_version?: string;
  clinical_review_status?: 'candidate_unverified' | 'not_flagged';
  previous_clinical_review_version?: string | null;
  previous_clinical_review_flags?: string[];
  historical_clinical_review_preserved?: boolean;
};

export type LocalSafety = SafetyHistory & (
  | {
      danger_detected: false;
      escalation_level: "none";
      review_role: "none";
      danger_reminder: null;
      matched_rules: [];
      safety_rule_version: string;
    }
  | {
      danger_detected: true;
      escalation_level: "emergency";
      review_role: "emergency_services";
      danger_reminder: string;
      matched_rules: [string, ...string[]];
      safety_rule_version: string;
    });

export type OrganizeResultMeta = {
  trace_id: string;
  provider: string;
  prompt_version: string;
  schema_version: SchemaVersion;
  latency_ms: number;
  safety_guard_applied: boolean;
  model_id?: string | null;
  prompt_sha256?: string;
  input_sha256?: string;
};

export type ModelTrace = {
  trace_id: string;
  provider: string | null;
  model_id?: string | null;
  prompt_version: string;
  prompt_sha256?: string;
  input_sha256?: string;
  schema_version: string;
  latency_ms?: number;
  safety_guard_applied?: boolean;
};

/** The complete event object returned by the core HTTP routes. */
export type Event = {
  record_id: string;
  raw_text: string;
  source_kind: SourceKind;
  actor_name: string;
  occurred_time: string | null;
  recorded_at: string;
  state: EventState;
  version: number;
  draft: AiDraft | null;
  result_meta: OrganizeResultMeta | null;
  review_notes: string | null;
  related_record_ids: string[];
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
  household_id: string;
  local_safety: LocalSafety;
  confirmation_scope: "record_accuracy" | null;
  /** Human source comparison of this exact version; never supplied by OCR. */
  source_review?: { method: "original_comparison"; text: string; confirmed_at: string } | null;
};

export type SourceReviewRequest = { expected_version: number; compared_with_original: true };

export type SaveEventRequest = {
  raw_text: string;
  source_kind: SourceKind;
  actor_name: string;
  occurred_time?: string | null;
  related_record_ids?: string[];
};

export type OrganizeEventRequest = {
  expected_version: number;
  actor_name?: string;
};

export type ReviewEventRequest =
  | {
      expected_version: number;
      action: "confirm";
      note?: string | null;
      actor_name?: string;
    }
  | {
      expected_version: number;
      action: "return";
      note: string;
      actor_name?: string;
    };

export type ReviseEventRequest = {
  expected_version: number;
  raw_text: string;
  source_kind: SourceKind;
  actor_name: string;
  reason: string;
  occurred_time?: string | null;
  related_record_ids?: string[];
};

export type CreateHandoffRequest = Record<string, never>;

export type LegacyHealthResponse = {
  ok: true;
  service: "medical-handoff-p0";
  provider: string;
  storage: "sqlite";
  mode: "local_single_household";
  schema_version: SchemaVersion;
  session_token: string;
};

export type LocalFirstHealthResponse = {
  ok: true;
  service: "bingli-beta";
  provider: string;
  storage: "encrypted_on_device";
  mode: "local_first";
  schema_version: SchemaVersion;
  access_configured: boolean;
};

export type HealthResponse = LegacyHealthResponse | LocalFirstHealthResponse;

export type AppConfigResponse = {
  ok: true;
  mode: "local_first";
  access_configured: boolean;
  cloud_backup_configured: boolean;
  product_name: "病历不归零·内测版";
  data_location: "this_device";
  backup_mode: "encrypted_archive";
  provider: string;
  capabilities: {
    text_ai: ConfiguredCapability;
    audio_recognition: ConfiguredCapability;
    image_recognition: ConfiguredCapability;
  };
};

// Mock is unavailable. True is configuration readiness only, not connectivity or quality.
export type ConfiguredCapability = { available: boolean; reason: string };

export type ConversationAction = "ask" | "reply" | "finish" | "urgent";

export type ConversationModelTurn = {
  turn_id: string;
  text: string;
  version?: number;
  // Previous assistant question or response; context only, never patient evidence.
  responding_to?: { turn_id: string; text: string };
};

export type AppSessionResponse =
  | { ok: true; authenticated: false }
  | { ok: true; authenticated: true; csrf_token: string; expires_at: number };

export type CloudBackupObject = {
  object_key: string;
  size: number;
  last_modified: string | null;
  etag: string | null;
};

export type CloudBackupGrant = {
  object_key: string;
  method: "PUT" | "GET";
  url: string;
  headers: Record<string, string>;
  expires_in: number;
  size?: number;
  sha256?: string;
};

export type CreateCloudBackupGrantRequest = {
  size: number;
  sha256: string;
};

export type CreateCloudBackupDownloadRequest = {
  object_key: string;
};

export type CloudBackupListResponse = { ok: true; backups: CloudBackupObject[] };
export type CloudBackupGrantResponse = { ok: true; grant: CloudBackupGrant };

export type StatelessOrganizeRequest = {
  record_id: string;
  raw_text: string;
  source_kind: SourceKind;
  source_review?: Event["source_review"];
  recorded_at: string;
  occurred_time?: string | null;
  history?: Array<Pick<Event, "record_id" | "raw_text" | "source_kind" | "source_review" | "recorded_at" | "occurred_time">>;
  consent: true;
};

export type StatelessOrganizeSuccess = LocalSafety & OrganizeResultMeta & {
  ok: true;
  ai_failed: false;
  output: AiDraft;
  raw_text_preserved_on_device: true;
  local_safety: LocalSafety;
};

export type StatelessMediaRecognitionSuccess = {
  ok: true;
  recognition: {
    text: string;
    provider: string;
    model: string;
    is_mock: boolean;
    attempt_id: string;
  };
  local_safety: LocalSafety;
};

export type SaveResponse = {
  ok: true;
  created: boolean;
  event: Event;
};

export type EventListResponse = {
  ok: true;
  events: Event[];
};

export type EventDetailResponse = {
  ok: true;
  event: Event;
};

export type OrganizeSuccess = LocalSafety & {
  ok: true;
  ai_failed: false;
  event: Event;
  output: AiDraft;
  trace_id: string;
  provider: string;
  prompt_version: string;
  schema_version: SchemaVersion;
  latency_ms: number;
  safety_guard_applied: boolean;
  raw_text_preserved: true;
  model_id?: string | null;
  prompt_sha256?: string;
  input_sha256?: string;
  local_safety: LocalSafety;
};

/** A 422 still contains the saved event and safety notice; clients must parse it. */
export type OrganizeFailure = LocalSafety & {
  ok: false;
  ai_failed: true;
  error: "ai_organize_failed";
  record_id: string;
  event: Event;
  raw_text_preserved: true;
  failure_type: string;
  failure_cause_type: string;
  failure_reason: string;
  trace_id: string;
  raw_text_sha256: string;
  prompt_version: string;
  schema_version: SchemaVersion;
  provider?: string | null;
  model_id?: string | null;
  prompt_sha256?: string;
  input_sha256?: string;
  failure_code?: string;
  provider_http_status?: number;
  local_safety: LocalSafety;
};

export type OrganizeResponse = OrganizeSuccess | OrganizeFailure;

export type ReviewResponse = {
  ok: true;
  event: Event;
};

export type ReviseResponse = {
  ok: true;
  event: Event;
};

export type RevisionAction =
  | "created"
  | "organized"
  | "review_confirm"
  | "review_return"
  | "superseded_by_revision"
  | "revised_from";

export type AuditAction = RevisionAction | "organize_failed";

export type EventSnapshot = Pick<
  Event,
  | "record_id"
  | "raw_text"
  | "source_kind"
  | "actor_name"
  | "occurred_time"
  | "recorded_at"
  | "state"
  | "version"
  | "draft"
  | "result_meta"
  | "review_notes"
  | "local_safety"
  | "related_record_ids"
  | "supersedes_id"
  | "confirmation_scope"
>;

export type EventRevision = {
  revision_id: string;
  record_id: string;
  action: RevisionAction;
  version: number;
  snapshot: EventSnapshot;
  actor_name: string;
  at: string;
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type AuditEntry = {
  audit_id: string;
  record_id: string;
  action: AuditAction;
  version: number;
  actor_name: string;
  at: string;
  details: JsonObject;
};

export type EventHistoryResponse = {
  ok: true;
  history: EventRevision[];
  audit: AuditEntry[];
};

export type UnresolvedReason =
  | "local_danger_detected"
  | "record_not_confirmed"
  | "draft_missing"
  | "professional_review_required"
  | "escalation_not_cleared"
  | "conflict_not_resolved"
  | "clinical_measurement_review_required";

export type HandoffItem = Event & {
  unresolved: boolean;
  unresolved_reasons: UnresolvedReason[];
};

export type Handoff = {
  pending_documents?: Array<{ record_id: string; recorded_at: string; reason: "document_source_review_required" }>;
  handoff_id: string;
  created_at: string;
  household_id: string | null;
  items: HandoffItem[];
  unresolved_count: number;
  media_attachments?: MediaHandoffAttachment[];
};

export type MediaHandoffAttachment = {
  media_id: string;
  kind: MediaKind;
  save_status: MediaSaveStatus;
  recognition_status: MediaRecognitionStatus;
  is_mock: boolean | null;
  link_status: MediaLinkStatus;
  record_id: string | null;
  pending_reason: string | null;
  has_text: boolean;
  local_safety: LocalSafety | null;
  unresolved: boolean;
  unresolved_reasons: string[];
};

export type HandoffResponse = {
  ok: true;
  handoff: Handoff;
};

export type CreateHandoffResponse = HandoffResponse;
export type HandoffDetailResponse = HandoffResponse;

/** Media HTTP adapter contract. The default runtime backend is local SQLite/filesystem. */
export type MediaKind = "audio" | "image";
export type MediaSaveStatus = "uploading" | "saved" | "failed";
export type MediaRecognitionStatus =
  | "not_started"
  | "processing"
  | "succeeded"
  | "failed"
  | "interrupted";
export type MediaLinkStatus =
  | "not_linked"
  | "pending"
  | "linked"
  | "link_failed";

export type MediaRecognitionError = {
  /** Stable provider/recognition failure persisted on a media attempt. */
  code: MediaRecognitionErrorCode;
  message: string;
  retryable: boolean;
};

export const MEDIA_RECOGNITION_ERROR_CODES = [
  "provider_not_configured",
  "unsupported_format",
  "invalid_media",
  "limit_exceeded",
  "no_text_detected",
  "provider_timeout",
  "provider_unavailable",
  "provider_auth_failed",
  "provider_rate_limited",
  "invalid_provider_response",
  "incomplete_provider_response",
] as const;

export type MediaRecognitionErrorCode =
  (typeof MEDIA_RECOGNITION_ERROR_CODES)[number];

export type MediaRecognitionAttempt = {
  attempt_id: string;
  media_id?: string;
  status: Exclude<MediaRecognitionStatus, "not_started">;
  provider?: string | null;
  model?: string | null;
  is_mock?: boolean | null;
  text?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  retryable?: boolean | null;
  started_at?: string;
  finished_at?: string | null;
  created_at?: string;
  local_safety?: LocalSafety;
};

export type MediaEventLink = {
  record_id: string;
  attempt_id: string;
  linked_at: string;
};

/** Public JSON media shape; server-owned paths and original bytes are absent. */
export type Media = {
  media_id: string;
  kind: MediaKind;
  content_type: string;
  size_bytes: number | null;
  sha256: string | null;
  save_status: MediaSaveStatus;
  recognition_status: MediaRecognitionStatus;
  link_status: MediaLinkStatus;
  /** Pending work can continue briefly after recognition reports succeeded. */
  link_pending_reason?: string | null;
  local_safety?: LocalSafety | null;
  version: number;
  original_filename?: string | null;
  household_id?: string;
  upload_id?: string | null;
  expected_parts?: number | null;
  uploaded_parts?: number;
  current_attempt_id?: string | null;
  upload_error_code?: string | null;
  upload_error_message?: string | null;
  recognition?: MediaRecognitionAttempt | null;
  event_link?: MediaEventLink | null;
  record_id?: string | null;
  created_at?: string;
  updated_at?: string;
  error?: MediaRecognitionError;
};

export type MediaCapabilities = {
  enabled: boolean;
  disabled_reason: "media_limits_not_configured" | null;
  max_total_bytes: number | null;
  max_part_bytes: number | null;
  max_parts: number | null;
  max_audio_duration_seconds: null;
  max_image_pixels: null;
  audio_content_types: string[];
  image_content_types: string[];
  multipart_upload: true;
  resumable_parts: true;
};

export type MediaCapabilitiesResponse = {
  ok: true;
  capabilities: MediaCapabilities;
};

/** Fields in POST /api/media/uploads multipart/form-data. No file is sent here. */
export type CreateMediaUploadRequest = {
  kind: MediaKind;
  content_type: string;
  total_parts: number;
  actor_name?: string;
  occurred_time?: string | null;
  expected_size?: number;
  expected_sha256?: string;
  original_filename?: string;
};

export type MediaUpload = {
  upload_id: string;
  media_id: string;
  kind: MediaKind;
  content_type: string;
  total_parts: number;
  status: "uploading";
};

export type CreateMediaUploadResponse = {
  ok: true;
  created: boolean;
  upload: MediaUpload;
};

export type CompleteMediaUploadRequest = Record<string, never>;

/** Fields in POST /api/media/uploads/{upload_id}/parts/{index}. */
export type MediaPartUploadRequest = {
  file: Blob;
};

export type MediaUploadPart = {
  upload_id: string;
  index: number;
  size_bytes: number;
};

export type MediaPartUploadResponse = {
  ok: true;
  created: boolean;
  part: MediaUploadPart;
};

export type CompleteMediaUploadResponse = {
  ok: true;
  created: boolean;
  media: Media & { save_status: "saved" };
};

export type MediaListResponse = {
  ok: true;
  media: Media[];
};

export type MediaDetailResponse = {
  ok: true;
  media: Media;
};

export type StartMediaRecognitionRequest = {
  expected_version: number;
  actor_name?: string;
};

/** A new task is 202; a successful replay is 200 and reuses the attempt. */
export type StartMediaRecognitionResponse =
  | {
      ok: true;
      accepted: true;
      attempt_id: string;
      media: Media & { recognition_status: "processing" };
    }
  | {
      ok: true;
      accepted: true;
      action: "existing" | "resume_link";
      attempt_id: string;
      media: Media & { recognition_status: "succeeded" };
      event?: Event;
    };

export type LinkMediaResponse = {
  ok: true;
  linked: boolean;
  event_created?: boolean;
  media: Media;
  event?: Event;
};

export type LinkMediaRequest = {
  expected_version: number;
  actor_name?: string;
};

export type MediaWriteHeaders = {
  "X-Session-Token": string;
  "Idempotency-Key": string;
};

export type MediaOriginalRequestHeaders = {
  "X-Session-Token": string;
  Range?: `bytes=${string}`;
};

export const MEDIA_HTTP_ERROR_CODES = [
  "media_limits_not_configured",
  "request_too_large",
  "body_too_large",
  "body_required",
  "body_must_object",
  "invalid_json_payload",
  "invalid_content_length",
  "incomplete_request_body",
  "invalid_multipart_payload",
  "unsupported_format",
  "limit_exceeded",
  "content_type_kind_mismatch",
  "invalid_media_kind",
  "invalid_original_filename",
  "invalid_sha256",
  "expected_parts_must_positive_integer",
  "expected_size_must_positive_integer",
  "invalid_media_size",
  "invalid_part_index",
  "invalid_part_size",
  "media_not_found",
  "upload_not_found",
  "media_id_conflict",
  "upload_id_conflict",
  "idempotency_key_payload_mismatch",
  "upload_conflict",
  "upload_not_open",
  "upload_incomplete",
  "upload_completed",
  "completed_upload_conflict",
  "stale_version",
  "idempotency_key_required",
  "invalid_media",
  "invalid_upload",
  "invalid_part",
  "integrity_mismatch",
  "storage_corrupt",
  "unsafe_storage",
  "storage_failed",
  "media_not_saved",
  "recognition_not_retryable",
  "stale_recognition_attempt",
  "safety_scan_required",
  "provider_timeout",
  "provider_unavailable",
  "provider_not_configured",
  "provider_auth_failed",
  "provider_rate_limited",
  "invalid_provider_response",
  "no_text_detected",
  "incomplete_provider_response",
  "document_source_review_required",
  "source_review_confirmation_required",
  "source_review_not_available",
  "conversation_source_invalid",
  "household_access_denied",
  "cross_household_reference_denied",
  "related_record_not_found",
  "complete_body_must_be_empty_object",
  "media_request_failed",
  "media_backend_unavailable",
  "invalid_range",
  "csrf_or_origin_rejected",
  "not_found",
  "internal_server_error",
] as const;

export type MediaHttpErrorCode = (typeof MEDIA_HTTP_ERROR_CODES)[number];
export type MediaErrorResponse = {
  ok: false;
  error: MediaHttpErrorCode;
};

/**
 * Stable error codes returned by the core elder-facing HTTP routes.
 *
 * Keep this list aligned with docs/API.md and backend/server.py. Account
 * compatibility routes are intentionally outside this MVP contract.
 */
export const CORE_HTTP_ERROR_CODES = [
  "body_too_large",
  "body_must_object",
  "raw_text_required",
  "raw_text_too_long",
  "source_kind_required",
  "source_kind_too_long",
  "invalid_source_kind",
  "actor_name_required",
  "actor_name_too_long",
  "occurred_time_required",
  "occurred_time_too_long",
  "recorded_at_read_only",
  "related_record_ids_must_bounded_list",
  "invalid_related_record_id",
  "duplicate_related_record_id",
  "related_record_not_found",
  "idempotency_key_required",
  "idempotency_key_too_long",
  "idempotency_key_payload_mismatch",
  "invalid_json_payload",
  "expected_version_must_positive_integer",
  "stale_version",
  "event_not_found",
  "handoff_not_found",
  "handoff_body_must_be_empty_object",
  "invalid_review_action",
  "note_required",
  "note_too_long",
  "return_note_required",
  "confirm_state_invalid",
  "draft_required",
  "return_state_invalid",
  "revision_reason_required",
  "revision_reason_too_long",
  "already_superseded",
  "organize_state_invalid",
  "validated_output_required",
  "cross_household_reference_denied",
  "invalid_session",
  "csrf_or_origin_rejected",
  "ai_organize_failed",
  "not_found",
  "internal_server_error",
] as const;

export type CoreHttpErrorCode = (typeof CORE_HTTP_ERROR_CODES)[number];

/** Known core errors remain exhaustively switchable by their `error` field. */
export type CommonErrorResponse<
  ErrorCode extends CoreHttpErrorCode = CoreHttpErrorCode,
> = {
  ok: false;
  error: ErrorCode;
};

/** Raw forward-compatible shape at the JSON boundary. */
export type RawCommonErrorResponse = {
  ok: false;
  error: string;
};

/**
 * A client-side classification for handling newer server errors safely without
 * widening CommonErrorResponse.error back to `string`.
 */
export type ClassifiedCommonErrorResponse =
  | {
      known_error: true;
      response: CommonErrorResponse;
    }
  | {
      known_error: false;
      response: RawCommonErrorResponse;
    };

const coreHttpErrorCodeSet: ReadonlySet<string> = new Set(
  CORE_HTTP_ERROR_CODES,
);

export function isCoreHttpErrorCode(
  error: string,
): error is CoreHttpErrorCode {
  return coreHttpErrorCodeSet.has(error);
}

export function classifyCommonErrorResponse(
  response: RawCommonErrorResponse,
): ClassifiedCommonErrorResponse {
  if (isCoreHttpErrorCode(response.error)) {
    const error = response.error;
    return {
      known_error: true,
      response: { ok: false, error },
    };
  }
  return { known_error: false, response };
}
