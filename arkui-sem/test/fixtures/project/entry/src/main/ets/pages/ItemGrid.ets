import { Item } from 'common';
import { ItemRow } from '../components/ItemRow';

@Component
export struct ItemGrid {
  @State items: Item[] = [];

  build() {
    Grid() {
      ForEach(this.items, (item: Item) => {
        GridItem() {
          ItemRow({ item: item })
        }
      })
    }
  }
}
