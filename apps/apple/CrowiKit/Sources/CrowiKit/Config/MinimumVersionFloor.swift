import Foundation

/// RFC-0016 §3 add-flow step 3 / §4.4 — the minimum-version gate.
///
/// **OQ-6 pin**: the exact floor string is a **placeholder** here —
/// determining the real value (the 2.0.x release that ships the seeded
/// `crowi-ios` OAuth client + validator relax + API/web auto-approve, §4.4)
/// is the umbrella's release-checklist job, not Phase 1's. What Phase 1 must
/// guarantee is that the floor is declared **exactly once**: this constant is
/// the single place any code that needs it reads from — never re-declared or
/// inlined elsewhere.
public enum MinimumVersionFloor {
    /// Placeholder floor (OQ-6). Filled in with the real minimum Crowi
    /// version when that companion release is cut.
    public static let floor = "2.0.0-alpha.1"

    public enum GateResult: Equatable, Sendable {
        /// The host's `version` is at or above `floor` — add-workspace may proceed.
        case ok
        /// The host's `version` parsed but is below `floor` — refused, no fallback.
        case tooOld(hostVersion: String, floor: String)
        /// The host's `version` did not parse as a semver at all — fails
        /// closed (treated the same as too old): an unparseable version is
        /// never assumed compatible.
        case unparseable(hostVersion: String)
    }

    /// Evaluate `hostVersion` (the lenient-decoded `/app/info.version`, may be
    /// `nil` if the host omitted it entirely) against `floor`.
    public static func evaluate(hostVersion: String?, floor: String = MinimumVersionFloor.floor) -> GateResult {
        guard let hostVersion, let host = SemVer(parsing: hostVersion) else {
            return .unparseable(hostVersion: hostVersion ?? "")
        }
        guard let floorVersion = SemVer(parsing: floor) else {
            // The floor constant itself must always be a valid semver — a
            // malformed floor is a programmer error, not a runtime host
            // condition, so this fails loudly rather than silently passing
            // every host.
            preconditionFailure("MinimumVersionFloor.floor is not a parseable semver: \(floor)")
        }
        return host >= floorVersion ? .ok : .tooOld(hostVersion: hostVersion, floor: floor)
    }
}

/// A minimal semver 2.0.0 precedence comparator — just enough to order the
/// `/app/info.version` strings Crowi actually emits (`MAJOR.MINOR.PATCH[-pre.release.ids]`).
/// Not a general-purpose semver library: no build-metadata handling (build
/// metadata has no bearing on precedence per the spec anyway), and identifier
/// comparison follows semver 2.0.0 §11's rules (numeric identifiers compare
/// numerically; a pre-release version has LOWER precedence than the
/// associated normal version; more pre-release fields with a shared prefix
/// sort higher).
struct SemVer: Comparable {
    let major: Int
    let minor: Int
    let patch: Int
    /// `nil` = no pre-release suffix (a plain release, e.g. `"2.0.0"`).
    let prerelease: [String]?

    init?(parsing raw: String) {
        let core: Substring
        let pre: Substring?
        if let dashIndex = raw.firstIndex(of: "-") {
            core = raw[raw.startIndex..<dashIndex]
            pre = raw[raw.index(after: dashIndex)...]
        } else {
            core = raw[...]
            pre = nil
        }
        let parts = core.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3,
            let major = Int(parts[0]),
            let minor = Int(parts[1]),
            let patch = Int(parts[2])
        else {
            return nil
        }
        self.major = major
        self.minor = minor
        self.patch = patch
        self.prerelease = pre.map { $0.split(separator: ".").map(String.init) }
    }

    static func == (lhs: SemVer, rhs: SemVer) -> Bool {
        lhs.major == rhs.major && lhs.minor == rhs.minor && lhs.patch == rhs.patch && lhs.prerelease == rhs.prerelease
    }

    static func < (lhs: SemVer, rhs: SemVer) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        if lhs.patch != rhs.patch { return lhs.patch < rhs.patch }
        switch (lhs.prerelease, rhs.prerelease) {
        case (nil, nil):
            return false
        case (.some, nil):
            // A pre-release has LOWER precedence than the plain release.
            return true
        case (nil, .some):
            return false
        case (.some(let lids), .some(let rids)):
            for (l, r) in zip(lids, rids) {
                if l == r { continue }
                let lNum = Int(l)
                let rNum = Int(r)
                switch (lNum, rNum) {
                case (.some(let ln), .some(let rn)):
                    return ln < rn
                case (.some, nil):
                    // Numeric identifiers always have lower precedence than
                    // alphanumeric identifiers in the same position.
                    return true
                case (nil, .some):
                    return false
                case (nil, nil):
                    return l < r
                }
            }
            // Shared prefix: fewer fields sorts lower.
            return lids.count < rids.count
        }
    }
}
