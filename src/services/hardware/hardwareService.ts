import { HardwareItem, ReservedHardwareItem, User } from "../../db/entity/hub";
import { Repository, Connection } from "typeorm";
import { createToken, parseToken } from "../../util/hardwareLibrary/hardwareItemToken";
import { ApiError, HttpResponseCode } from "../../util/errorHandling";
import { LoggerLevels, QueryLogger } from "../../util/logging";
import { HardwareObject } from "./hardwareObjectOptions";

export class HardwareService {
  private hubConnection: Connection;
  private hardwareRepository: Repository<HardwareItem>;
  private reservedHardwareItemRepository: Repository<ReservedHardwareItem>;
  private userRepository: Repository<User>;

  constructor(_hubConnection: Connection, _hardwareRepository: Repository<HardwareItem>, _reservedHardwareItemRepository: Repository<ReservedHardwareItem>, _userRepository: Repository<User>) {
    this.hubConnection = _hubConnection;
    this.hardwareRepository = _hardwareRepository;
    this.reservedHardwareItemRepository = _reservedHardwareItemRepository;
    this.userRepository = _userRepository;
  }

  /**
   * Finds the item by name and tries to reserve the item for the user
   * @param itemToReserve
   * @return A boolean indicating if the item was successfully reserved
   */
  reserveItem = async (user: User, itemToReserve: string, requestedQuantity?: number): Promise<string> => {
    if (!requestedQuantity) requestedQuantity = 1;

    const hardwareItem: HardwareItem = await this.getHardwareItemByID(Number(itemToReserve));
    if (await this.isItemReservable(user, hardwareItem, requestedQuantity)) {
      return this.reserveItemQuery(user, hardwareItem, requestedQuantity);
    }
    return undefined;
  };

  getHardwareItemByID = async (hardwareItemID: number): Promise<HardwareItem> => {
    try {
      const item: HardwareItem = await this.hardwareRepository
        .findOne({ where: {
            id: hardwareItemID
          }
        });
      return item ? item : undefined;
    } catch (err) {
      throw new Error(`Lost connection to database (hub)! ${err}`);
    }
  };

  /**
   * Reserves the item, adding the reservation to the database
   * @param user
   * @param hardwareItem
   */
  reserveItemQuery = async (user: User, hardwareItem: HardwareItem, requestedQuantity: number): Promise<string> => {
    try {
      // Create the new item reservation object
      const newItemReservation: ReservedHardwareItem = new ReservedHardwareItem();
      newItemReservation.user = user;
      newItemReservation.hardwareItem = hardwareItem;
      newItemReservation.reservationToken = createToken();
      newItemReservation.isReserved = true;
      newItemReservation.reservationQuantity = requestedQuantity;

      // Sets the reservation expiry to be current time + 30 minutes
      newItemReservation.reservationExpiry = new Date(new Date().getTime() + (1000 * 60 * 30));


      await this.hubConnection.transaction(async transaction => {
      // Insert the reservation into the database
      await transaction
        .getRepository(ReservedHardwareItem)
        .save(newItemReservation);

      // Increment the reservation count for the hardware item
      await transaction
        .getRepository(HardwareItem)
        .increment({ id: hardwareItem.id }, "reservedStock", requestedQuantity);
      });

      return newItemReservation.reservationToken;
    } catch (err) {
      throw new Error(`Lost connection to database (hub)! ${err}`);
    }
  };

  /**
   * Checks that the user is able to reserve the item
   * @param user
   * @param hardwareItem
   */
  isItemReservable = async (user: User, hardwareItem: HardwareItem, requestedQuantity: number): Promise<boolean> => {
    // Check the user has not reserved this item yet
    const hasUserNotReserved: boolean = await this.userRepository
      .count({
        join: {
          alias: "item",
          innerJoinAndSelect: { hardwareItems: "hardwareItems" }
        },
        where: {
          id: user.id,
          hardwareItemId: hardwareItem.id
        }
      }) == 0;

    // Check the requested item still has non reserved stock
    const hasStock: boolean = (hardwareItem.totalStock - (hardwareItem.reservedStock + hardwareItem.takenStock) - requestedQuantity) >= 0;

    if (!hasStock) {
      throw new ApiError(HttpResponseCode.BAD_REQUEST, "Not enough items in stock!");
    }

    return hasStock && hasUserNotReserved;
  };

  /**
   * Takes an item from the library
   * @param token token of the reservation
   */
  takeItem = async (token: string): Promise<boolean> => {
    const reservation: ReservedHardwareItem = await parseToken(token);
    if (!reservation) return undefined;

    const userID: number = reservation.user.id,
      itemID: number = reservation.hardwareItem.id,
      isReserved: boolean = reservation.isReserved,
      itemQuantity: number = reservation.reservationQuantity;

    if (isReserved) {
      // Checks that reservation is not expired
      if (!this.isReservationValid(reservation.reservationExpiry)) {
        // Remove the reservation from the database
        await this.deleteReservation(token);
        return undefined;
      }

      await this.itemToBeTakenFromLibrary(userID, itemID, itemQuantity);
    } else {
      throw new ApiError(HttpResponseCode.BAD_REQUEST, "This item is already taken");
    }

    return isReserved;
  };

  /**
   * Returns an item to the library
   * @param token token of the reservation
   */
  returnItem = async (token: string): Promise<boolean> => {
    const reservation: ReservedHardwareItem = await parseToken(token);
    if (!reservation) return undefined;

    const userID: number = reservation.user.id,
      itemID: number = reservation.hardwareItem.id,
      isReserved: boolean = reservation.isReserved,
      itemQuantity: number = reservation.reservationQuantity;

    if (!isReserved) {
      await this.itemToBeReturnedToLibrary(userID, itemID, token, itemQuantity);
    } else {
      throw new ApiError(HttpResponseCode.BAD_REQUEST, "This has not been taken yet");
    }

    return isReserved;
  };

  /**
   * Helper function to check that the expiry time has not been reached
   * @param expiryDate
   */
  isReservationValid = (expiryDate: Date): boolean => {
    return Date.now() <= expiryDate.getTime();
  };

  itemToBeTakenFromLibrary = async (userID: number, hardwareItemID: number, itemQuantity: number): Promise<void> => {
    // The item is reserved and we mark the item as taken
    try {
      await this.hubConnection.transaction(async transaction => {
        await transaction
          .createQueryBuilder()
          .update(ReservedHardwareItem)
          .set({ isReserved: false })
          .where("userId = :uid", { uid: userID })
          .andWhere("hardwareItemId = :hid", { hid: hardwareItemID })
          .execute();

        await transaction
          .createQueryBuilder()
          .update(HardwareItem)
          .set({
            takenStock: () => `takenStock + ${itemQuantity}`,
            reservedStock: () => `reservedStock - ${itemQuantity}`
          })
          .where("id = :id", { id: hardwareItemID })
          .execute();

          const message: string = `UID ${userID} took ${itemQuantity} of ${hardwareItemID}`;
          new QueryLogger().hardwareLog(LoggerLevels.LOG, message);
      });
    } catch (err) {
      throw new Error(`Lost connection to database (hub)! ${err}`);
    }
  };

  /**
   * Using the unique token the item is returned to the hardware library
   * @param hardwareItemID
   * @param token
   */
  itemToBeReturnedToLibrary = async (userID: number, hardwareItemID: number, token: string, itemQuantity: number): Promise<void> => {
    // The item is being returned
    try {
      // Decrement the reservation count for the hardware item
      await this.hardwareRepository
        .decrement({ id: hardwareItemID }, "takenStock", itemQuantity);

      // Delete the user reservation from the database
      await this.reservedHardwareItemRepository
        .delete(token);

      const message: string = `UID ${userID} returned ${itemQuantity} of ${hardwareItemID}`;
      new QueryLogger().hardwareLog(LoggerLevels.LOG, message);
    } catch (err) {
      throw new Error(`Lost connection to database (hub)! ${err}`);
    }
  };

  /**
   * Fetches all hardware items with their reservations
   */
  getAllHardwareItemsWithReservations = async (): Promise<HardwareItem[]> => {
    const items: HardwareItem[] = await this.hardwareRepository
      .createQueryBuilder("hardwareItem")
      .leftJoinAndSelect("hardwareItem.reservations", "reservations")
      .leftJoinAndSelect("reservations.user", "user")
      .orderBy("hardwareItem.name")
      .getMany();

    return items;
  };

  /**
   * Returns all the hardware items from the database in a formatted array
   */
  getAllHardwareItems = async (userId?: number): Promise<Object[]> => {
    const hardwareItems: HardwareItem[] = await this.hardwareRepository
      .find({
        order: {
          name: "ASC"
        }
      });

    const allUserReservations: ReservedHardwareItem[] = await this.reservedHardwareItemRepository
      .createQueryBuilder("reservation")
      .addSelect("user.id")
      .leftJoin("reservation.user", "user")
      .leftJoinAndSelect("reservation.hardwareItem", "hardwareItem")
      .getMany();

    const formattedData = [];
    for (const item of hardwareItems) {
      let remainingItemCount: number = item.totalStock - (item.reservedStock + item.takenStock);

      let reservationForItem: ReservedHardwareItem = allUserReservations.find((reservation) => reservation.hardwareItem.name === item.name);
      if (reservationForItem && reservationForItem.isReserved && !this.isReservationValid(reservationForItem.reservationExpiry)) {
        remainingItemCount += reservationForItem.reservationQuantity;
        await this.deleteReservation(reservationForItem.reservationToken);
        reservationForItem = undefined;
      }

      const isUsersReservation: boolean = (reservationForItem !== undefined && userId && reservationForItem.user.id === userId)
        ? true : false;

      formattedData.push({
        "itemID": item.id,
        "itemName": item.name,
        "itemURL": item.itemURL,
        "itemStock": item.totalStock,
        "itemsLeft": remainingItemCount,
        "itemHasStock": remainingItemCount > 0 ? "true" : "false",
        "reserved": isUsersReservation ? reservationForItem.isReserved : false,
        "taken": isUsersReservation ? !reservationForItem.isReserved : false,
        "reservationQuantity": isUsersReservation ? reservationForItem.reservationQuantity : 0,
        "reservationToken": isUsersReservation ? reservationForItem.reservationToken : "",
        "expiresIn": isUsersReservation ? Math.floor((reservationForItem.reservationExpiry.getTime() - Date.now()) / 60000) : 0
      });
    }
    return formattedData;
  };

  /**
   * Adds new hardware items to the database
   *
   * @param items
   */
  addAllHardwareItems = async (items: HardwareObject[]): Promise<void> => {
    const hardwareItems: Array<HardwareItem> = new Array<HardwareItem>();

    items.forEach((item: HardwareObject) => {
      const newHardwareItem = new HardwareItem();
      newHardwareItem.name = item.itemName;
      newHardwareItem.itemURL = item.itemURL;
      newHardwareItem.totalStock = item.itemStock;
      newHardwareItem.reservedStock = 0;
      newHardwareItem.takenStock = 0;

      hardwareItems.push(newHardwareItem);
    });

    try {
      await this.hardwareRepository.save(hardwareItems);
    } catch (err) {
      throw new Error(`Lost connection to database (hub)! ${err}`);
    }
  };

  /**
   * Deletes an item if it has no reservations
   * @param id The id of the item to delete
   */
  deleteHardwareItem = async(id: number): Promise<void> => {
    const itemId = id;
    const item: HardwareItem = await this.hardwareRepository.findOne(itemId);

    if (!item) {
      throw new ApiError(HttpResponseCode.BAD_REQUEST, "Could not find an item with the given id!");
    }
    if (item.reservedStock != 0 || item.takenStock != 0) {
      throw new ApiError(HttpResponseCode.BAD_REQUEST, "Cannot delete an item that has reservations!");
    }
    await this.hardwareRepository.delete(itemId);
  };

  getAllReservations = async (): Promise<ReservedHardwareItem[]> => {
    try {
      const reservations = await this.reservedHardwareItemRepository
        .createQueryBuilder("reservation")
        .innerJoinAndSelect("reservation.hardwareItem", "item")
        .innerJoinAndSelect("reservation.user", "user")
        .getMany();
      return reservations;
    } catch (err) {
      throw new Error(`Lost connection to database (hub)! ${err}`);
    }
  };


  getReservation = async (token: string): Promise<ReservedHardwareItem> => {
    try {
      const reservation = await this.reservedHardwareItemRepository
        .createQueryBuilder("reservation")
        .innerJoinAndSelect("reservation.hardwareItem", "item")
        .innerJoinAndSelect("reservation.user", "user")
        .where("reservation.reservationToken = :token", { token })
        .getOne();
      return reservation;
    } catch (err) {
      throw new Error(`Lost connection to database (hub)! ${err}`);
    }
  };

  cancelReservation = async (token: string, userId: number): Promise<void> => {
    const reservation = await this.reservedHardwareItemRepository
      .createQueryBuilder("reservation")
      .innerJoinAndSelect("reservation.hardwareItem", "item")
      .innerJoinAndSelect("reservation.user", "user")
      .where("reservation.reservationToken = :token", { token })
      .andWhere("userId = :userId", { userId })
      .getOne();
    if (!reservation) {
      throw new ApiError(HttpResponseCode.BAD_REQUEST, "Could not find reservation!");
    }
    if (!reservation.isReserved) {
      throw new ApiError(HttpResponseCode.BAD_REQUEST, "This reservation cannot be cancelled!");
    }
    await this.hubConnection.transaction(async transaction => {
      const response = await transaction
        .getRepository(ReservedHardwareItem)
        .delete(token);
      if (response.raw.affectedRows != 1) {
        await transaction
          .getRepository(ReservedHardwareItem)
          .save(reservation);
        throw new ApiError(HttpResponseCode.INTERNAL_ERROR, "Could not cancel reservation, please inform us that this error occured.");
      } else {
        reservation.hardwareItem.reservedStock -= reservation.reservationQuantity;
        await transaction
          .getRepository(HardwareItem)
          .save(reservation.hardwareItem);
      }
    });
  };

  deleteReservation = async (tokenToDelete: string): Promise<void> => {
    try {
      await this.hubConnection.transaction(async transaction => {
        const reservation: ReservedHardwareItem = await parseToken(tokenToDelete, transaction);
        const itemID: number = reservation.hardwareItem.id,
          itemQuantity: number = reservation.reservationQuantity;

        await transaction
          .getRepository(ReservedHardwareItem)
          .delete(tokenToDelete);

        // Decrement the reservation count for the hardware item
        await transaction
          .getRepository(HardwareItem)
          .decrement({ id: itemID }, "reservedStock", itemQuantity);
      });

    } catch (err) {
      throw new Error(`Lost connection to database (hub)! ${err}`);
    }
  };

  updateHardwareItem = async (itemToUpdate: HardwareItem): Promise<void> => {
    try {
      await this.hardwareRepository.save(itemToUpdate);
    } catch (err) {
      throw new Error(`Lost connection to database (hub)! ${err}`);
    }
  };
}