import Foundation
import PDFKit
import Vision
import AppKit
import Security

struct Result: Encodable {
    let text: String
    let pages: Int
    let usedOCR: Bool
    let qrCodes: [String]
    let needsPassword: Bool
    let passwordRejected: Bool
}

func imageForPage(_ page: PDFPage, scale: CGFloat = 2.5) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    let width = Int(bounds.width * scale)
    let height = Int(bounds.height * scale)
    guard width > 0, height > 0, width < 10000, height < 10000 else { return nil }
    return page.thumbnail(of: NSSize(width: width, height: height), for: .mediaBox)
        .cgImage(forProposedRect: nil, context: nil, hints: nil)
}

func ocr(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["de-DE", "en-US"]
    request.usesLanguageCorrection = true
    do {
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    } catch { return "" }
}

func qrPayloads(_ image: CGImage) -> [String] {
    let request = VNDetectBarcodesRequest()
    request.symbologies = [.qr]
    do {
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.payloadStringValue }
    } catch { return [] }
}

// Passwort wird ausschließlich über stdin übergeben, nicht als Prozessargument.
struct Input: Decodable { let password: String?; let savePassword: Bool? }
let service = "de.raycast.rechnung-ueberweisen.pdf"
let account = "apothekenrechnungen"
func savedPassword() -> String? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: account,
                                kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
}
func storePassword(_ password: String) -> Bool {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: account]
    let attributes: [String: Any] = [kSecValueData as String: Data(password.utf8),
                                     kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked]
    let status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
    if status == errSecSuccess { return true }
    if status == errSecDuplicateItem {
        return SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecSuccess
    }
    return false
}
let inputData = FileHandle.standardInput.readDataToEndOfFile()
let input = (try? JSONDecoder().decode(Input.self, from: inputData)) ?? Input(password: nil, savePassword: nil)
guard CommandLine.arguments.count == 2,
      let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else {
    fputs("PDF konnte nicht geöffnet werden\n", stderr)
    exit(1)
}
if document.isLocked {
    let manual = input.password ?? ""
    let stored = savedPassword() ?? ""
    var unlocked = false
    if !manual.isEmpty { unlocked = document.unlock(withPassword: manual) }
    else if !stored.isEmpty { unlocked = document.unlock(withPassword: stored) }
    if !unlocked {
        let result = Result(text: "", pages: 0, usedOCR: false, qrCodes: [], needsPassword: true,
                            passwordRejected: !manual.isEmpty)
        FileHandle.standardOutput.write(try JSONEncoder().encode(result))
        exit(0)
    }
    if !manual.isEmpty && input.savePassword == true && !storePassword(manual) {
        fputs("Passwort konnte nicht im Schlüsselbund gespeichert werden\n", stderr)
        exit(1)
    }
}
var output: [String] = []
var codes: [String] = []
var usedOCR = false
for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else { continue }
    var text = page.string ?? ""
    let image = imageForPage(page)
    if let image = image {
        codes.append(contentsOf: qrPayloads(image))
        if text.trimmingCharacters(in: .whitespacesAndNewlines).count < 50 {
            text = ocr(image)
            usedOCR = true
        }
    }
    output.append(text)
}
let result = Result(text: output.joined(separator: "\n"), pages: document.pageCount, usedOCR: usedOCR,
                    qrCodes: Array(Set(codes)).sorted(), needsPassword: false, passwordRejected: false)
let data = try JSONEncoder().encode(result)
FileHandle.standardOutput.write(data)
