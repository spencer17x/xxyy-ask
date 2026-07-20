#!/usr/bin/env swift
import AppKit
import Foundation
import Vision

struct OcrLine: Codable {
    let confidence: Float
    let text: String
}

struct OcrResult: Codable {
    let path: String
    let lines: [OcrLine]
    let error: String?
}

let encoder = JSONEncoder()

func emit(_ result: OcrResult) {
    guard let data = try? encoder.encode(result), let json = String(data: data, encoding: .utf8) else {
        return
    }
    print(json)
}

func loadImage(path: String) -> CGImage? {
    guard let image = NSImage(contentsOfFile: path) else {
        return nil
    }
    var rect = NSRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

for imagePath in CommandLine.arguments.dropFirst() {
    autoreleasepool {
        guard let image = loadImage(path: imagePath) else {
            emit(OcrResult(path: imagePath, lines: [], error: "Unable to decode image"))
            return
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
        request.usesLanguageCorrection = true

        do {
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
            let observations = (request.results ?? []).sorted { left, right in
                let rowDelta = left.boundingBox.midY - right.boundingBox.midY
                if abs(rowDelta) > 0.015 {
                    return rowDelta > 0
                }
                return left.boundingBox.minX < right.boundingBox.minX
            }
            let lines = observations.compactMap { observation -> OcrLine? in
                guard let candidate = observation.topCandidates(1).first else {
                    return nil
                }
                return OcrLine(confidence: candidate.confidence, text: candidate.string)
            }
            emit(OcrResult(path: imagePath, lines: lines, error: nil))
        } catch {
            emit(OcrResult(path: imagePath, lines: [], error: error.localizedDescription))
        }
    }
}
