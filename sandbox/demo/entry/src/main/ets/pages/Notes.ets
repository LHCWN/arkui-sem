interface Note {
  id: number
  title: string
}

@Entry
@Component
struct Notes {
  @State notes: Note[] = [{ id: 1, title: 'Groceries' }, { id: 2, title: 'Call the bank' }]
  @State query: string = ''
  @State editingId: number = -1
  @State draft: string = ''

  edit(note: Note): void {
    this.editingId = note.id
    this.draft = note.title
  }

  save(): void {
    this.notes = this.notes.map((note) => note.id === this.editingId ? { id: note.id, title: this.draft } : note)
    this.editingId = -1
  }

  build() {
    Column({ space: 8 }) {
      Search({ placeholder: 'Search notes' })
        .onChange((value: string) => {
          this.query = value
        })
      ForEach(this.notes, (note: Note) => {
        Row() {
          Text(note.title).layoutWeight(1)
          Button('Edit').onClick(() => this.edit(note))
        }
      }, (note: Note) => `${note.id}-${note.title}`)
      if (this.editingId >= 0) {
        TextInput({ placeholder: 'Title' })
          .onChange((value: string) => {
            this.draft = value
          })
        Button('Save').onClick(() => this.save())
      }
    }
    .padding(16)
  }
}
