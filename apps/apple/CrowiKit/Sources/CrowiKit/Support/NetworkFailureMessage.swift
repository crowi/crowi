import Foundation

/// Plain sentences for the transport failures a self-hosted wiki client
/// actually hits.
///
/// This is deliberately the ONLY place error codes are turned into copy, and
/// deliberately covers only `URLError`. Everywhere else a screen catches its
/// own failure and writes the sentence that is true THERE: the same 404 means
/// "no such page" on one screen and "not shared with you yet" on another, so a
/// central table would have to blur both into one vaguer sentence. `URLError`
/// is the exception because its codes mean the same thing wherever they occur
/// — the connection failed, and how it failed is all the reader needs.
///
/// Returns `nil` for anything else, which is the caller's signal to fall back
/// to its own wording rather than print Apple's.
public enum NetworkFailureMessage {
    public static func message(for error: Error) -> String? {
        guard let error = error as? URLError else { return nil }
        switch error.code {
        case .notConnectedToInternet:
            return "You're offline."
        case .networkConnectionLost:
            return "The connection was lost."
        case .timedOut:
            return "The server took too long to respond."
        case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
            return "Couldn't reach that server. Check the address."
        case .secureConnectionFailed,
             .serverCertificateUntrusted,
             .serverCertificateHasBadDate,
             .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid:
            // Worth its own sentence rather than "couldn't reach": a
            // self-signed certificate on an internal host is a configuration
            // the reader can actually act on, and it looks like an outage
            // otherwise.
            return "The server's certificate wasn't accepted."
        case .appTransportSecurityRequiresSecureConnection:
            return "This server must use HTTPS."
        default:
            return nil
        }
    }
}
