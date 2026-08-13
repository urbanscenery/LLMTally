import SwiftUI

/// Row-level drag-to-reorder for custom (non-List) stacks — the Builder
/// item list and the Settings Overview order share it. The dragged row
/// swaps into place as it passes over siblings; `move` persists, so a
/// cancelled drop never leaves unsaved state.
struct DragReorderDelegate: DropDelegate {
    let itemId: String
    @Binding var draggedId: String?
    let indexOf: (String) -> Int?
    let move: (Int, Int) -> Void

    func dropEntered(info: DropInfo) {
        guard let dragged = draggedId, dragged != itemId,
              let from = indexOf(dragged), let to = indexOf(itemId), from != to else { return }
        withAnimation(.easeInOut(duration: 0.15)) {
            move(from, to)
        }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .move)
    }

    func performDrop(info: DropInfo) -> Bool {
        draggedId = nil
        return true
    }
}

extension Array {
    /// `move(fromOffsets:toOffset:)` with plain indices — the +1 rule
    /// for downward moves lives here once.
    mutating func moveElement(from: Int, to: Int) {
        move(fromOffsets: IndexSet(integer: from), toOffset: to > from ? to + 1 : to)
    }
}
