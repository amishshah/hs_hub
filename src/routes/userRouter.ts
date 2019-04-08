import { Router } from "express";
import { UserController } from "../controllers/userController";
import { checkIsLoggedIn, checkIsVolunteer, checkIsOrganizer } from "../util/user";
import { UsersService } from "../services/users";
import { getConnection } from "typeorm";
import { ApplicationUser, ApplicationTeam } from "../db/entity/applications";
import { User } from "../db/entity/hub";

/**
 * A router for handling the sign in of a user
 */
export const userRouter = (): Router => {
  const userService: UsersService = new UsersService(
    getConnection("hub").getRepository(User),
    getConnection("applications").getRepository(ApplicationUser),
    getConnection("applications").getRepository(ApplicationTeam));


  const router = Router();
  const userController = new UserController(userService);

  /**
   * POST /user/login
   */
  router.post("/login", userController.login);

  /**
   * GET /user/profile
   */
  router.get("/profile", checkIsLoggedIn, userController.profile);

  /**
   * GET /user/[any valid number]
   */
  router.get(/[0-9]+/, checkIsVolunteer, userController.profile);

  /**
   * GET /user/checkVolunteer
   * Used only to test out checkIsVolunteer, to be removed in next pull request
   */
  router.get("/checkVolunteer", checkIsVolunteer, userController.test);

  /**
   * GET /user/checkOrganizer
   * Used of only to test out checkIsOrganizer, to be removed in next pull request
   */
  router.get("/checkOrganizer", checkIsOrganizer, userController.test);

  /**
   * GET /user/checkAttendee
   * Used of only to test out checkIsLoggedIn, to be removed in next pull request
   */
  router.get("/checkAttendee", checkIsLoggedIn, userController.test);

  /**
   * GET /user/logout
   */
  router.get("/logout", checkIsLoggedIn, userController.logout);

  return router;
};
