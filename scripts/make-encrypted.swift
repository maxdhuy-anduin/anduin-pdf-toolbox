// macOS only: writes a password-protected copy of a PDF using PDFKit.
// usage: swift scripts/make-encrypted.swift in.pdf out.pdf
import PDFKit
let a = CommandLine.arguments
guard a.count == 3, let doc = PDFDocument(url: URL(fileURLWithPath: a[1])) else { print("bad args"); exit(1) }
let ok = doc.write(to: URL(fileURLWithPath: a[2]), withOptions: [.userPasswordOption: "secret", .ownerPasswordOption: "owner"])
print(ok ? "encrypted ok" : "failed")
