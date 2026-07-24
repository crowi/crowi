import Foundation

/// `feature-ios-phase2-write` — lenient decode of the server's shared
/// `{ error: { code, message } }` envelope (the literal shape
/// `handlers/page.ts`'s `pageBadRequestBody` / `pageRevisionConflictBody` /
/// `INVALID_GRANT_BODY` helpers emit), the ONE typed error surface every
/// write flow discriminates on. Follows the `AppInfoLenient` pattern:
/// `decode` NEVER throws — a garbage / empty / differently-shaped body
/// degrades to an all-`nil` envelope, and the flows treat an unknown or
/// missing `code` as a generic failure. HTTP status stays primary (the
/// architectural pin: "status first, code second"), so this type carries no
/// status of its own — the caller already has it from
/// `AuthenticatedAPIClient`.
public struct APIErrorEnvelopeLenient: Sendable, Equatable {
    public let code: String?
    public let message: String?

    public init(code: String?, message: String?) {
        self.code = code
        self.message = message
    }

    public static func decode(_ data: Data) -> APIErrorEnvelopeLenient {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let errorDict = object["error"] as? [String: Any]
        else {
            return APIErrorEnvelopeLenient(code: nil, message: nil)
        }
        return APIErrorEnvelopeLenient(code: errorDict["code"] as? String, message: errorDict["message"] as? String)
    }
}

/// The thrown-error form of a non-2xx write response, for the single-shot
/// write calls (`EngagementActions`) whose callers only need "it failed,
/// revert the optimistic update" — unlike `PageCreateFlow` /
/// `PageEditSession`, which return rich per-code outcome states instead of
/// throwing. A transport failure (offline, DNS — §7.4's fail-fast case) is
/// NOT wrapped in this type: it propagates as the underlying `URLError` so
/// the UI can offer a manual retry.
public struct WriteRequestError: Error, Sendable, Equatable {
    public let status: Int
    public let code: String?
    public let message: String?

    public init(status: Int, code: String?, message: String?) {
        self.status = status
        self.code = code
        self.message = message
    }

    public static func from(status: Int, data: Data) -> WriteRequestError {
        let envelope = APIErrorEnvelopeLenient.decode(data)
        return WriteRequestError(status: status, code: envelope.code, message: envelope.message)
    }
}
