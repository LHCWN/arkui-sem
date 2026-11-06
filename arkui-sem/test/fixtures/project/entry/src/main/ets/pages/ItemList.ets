import { Item } from 'common';
import { ItemRow } from '../components/ItemRow';

@Entry
@Component
struct ItemList {
  @State items: Item[] = [new Item()];

  build() {
    Column() {
      ForEach(this.items, (item: Item) => {
        ItemRow({ item: item })
      })
      Button('rename').onClick(() => {
        this.items[0].title = 'renamed';
      })
    }
  }
}
